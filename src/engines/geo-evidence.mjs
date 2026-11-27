import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { GeoStore } from "../../engines/geo-evidence/lib/store.mjs";
import { GeoEvidenceService } from "../../engines/geo-evidence/lib/service.mjs";
import {
  PERSONAL_GEO_CASE,
  buildPersonalQueries,
} from "../../engines/geo-evidence/personal-case.mjs";
import { resolveDeepSeekApiKey } from "../adapters/auth.mjs";
import { ApiError } from "../domain/errors.mjs";
import { hashObject, hashText } from "../domain/hash.mjs";
import { assertOperationReviewCurrent, reviewOperationEvidence } from "../services/operations-review.mjs";

const LEGACY_CONTROL_QUERIES = JSON.parse(readFileSync(
  new URL("../../data/migrations/identity-v1.json", import.meta.url), "utf8",
)).queries;
const LEGACY_PERSONAL_QUERIES = JSON.parse(readFileSync(
  new URL("../../engines/geo-evidence/personal-case-v1-queries.json", import.meta.url), "utf8",
));

function mapControlQuery(query) {
  const category =
    query.intent === "recruiting"
      ? "recruiting"
      : query.intent === "entity"
        ? "brand"
        : query.intent === "project"
          ? "category"
          : "scene";
  return {
    id: query.id,
    text: query.text,
    category,
    categoryLabel:
      category === "brand"
        ? "个人实体"
        : category === "recruiting"
          ? "招聘意图"
          : category === "category"
            ? "能力与产品"
            : "方法与场景",
    priority: query.priority,
    risk: false,
    product: null,
    status: "approved",
    source: query.source ?? "control-plane-query-set/v1",
  };
}

export class PersonalGeoEngine {
  constructor({
    rootDir,
    databasePath = join(rootDir, "var", "geo-engine", "personal-geo.sqlite"),
    controlQueries = [],
    env = process.env, fetchImpl,
    aiApproval = null,
  }) {
    this.rootDir = resolve(rootDir);
    this.controlQueryIds = new Set(controlQueries.map((query) => query.id));
    this.store = new GeoStore(databasePath, {
      caseConfig: PERSONAL_GEO_CASE,
      queries: [
        ...buildPersonalQueries(PERSONAL_GEO_CASE),
        ...controlQueries.map(mapControlQuery),
      ],
      queryBaseline: [
        ...LEGACY_PERSONAL_QUERIES,
        ...LEGACY_CONTROL_QUERIES.map(mapControlQuery),
      ],
    });
    this.service = new GeoEvidenceService(this.store, {
      rootDir: join(this.rootDir, "var", "geo-engine"),
      env, fetchImpl,
      caseConfig: PERSONAL_GEO_CASE,
    });
    this.aiApproval = aiApproval;
    if (aiApproval) this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS pengmanager_article_reviews (
        article_id TEXT NOT NULL REFERENCES articles(id),
        snapshot_hash TEXT NOT NULL,
        markdown_sha256 TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (article_id, snapshot_hash)
      );
    `);
  }

  health() {
    return {
      ok: true,
      configured: true,
      mode: "in-process-personal-geo-engine",
      caseId: PERSONAL_GEO_CASE.id,
      database: this.store.path,
      queries: this.store.listQueries({ limit: 2000 }).length,
      summary: this.summary().metrics,
    };
  }

  summary({ runId } = {}) {
    const summary = this.service.summary({
      runId,
      dataModes: ["real", "imported"],
    });
    const queries = this.store.listQueries({ limit: 2000 });
    const samples = this.store.listSamples({ runId, limit: 5000 })
      .filter((sample) => ["real", "imported"].includes(sample.dataMode));
    const observedQueries = new Set(samples.map((sample) => sample.query_id));
    const coverageIds =
      this.controlQueryIds.size > 0
        ? this.controlQueryIds
        : new Set(queries.map((query) => query.id));
    const observedCoverage = [...coverageIds].filter((id) =>
      observedQueries.has(id),
    ).length;
    return {
      ...summary,
      totalQueries: coverageIds.size,
      observedQueries: observedCoverage,
      queryCoverage:
        coverageIds.size === 0
          ? null
          : Number((observedCoverage / coverageIds.size).toFixed(4)),
    };
  }

  listQueries(options) {
    return this.store.listQueries(options);
  }

  upsertControlQueries(queries) {
    this.store.upsertQueries(queries.map(mapControlQuery), PERSONAL_GEO_CASE);
    return queries;
  }

  listSamples(options) {
    return this.store.listSamples(options);
  }

  listIncidents(options) {
    return this.store.listIncidents(options);
  }

  async runVisibility({
    provider = "deepseek-search",
    limit = 12,
    queryIds,
    platform = "deepseek",
  } = {}) {
    if (provider.startsWith("deepseek")) {
      this.service.env = {
        ...this.service.env,
        DEEPSEEK_API_KEY: resolveDeepSeekApiKey(this.service.env),
        DEEPSEEK_BASE_URL:
          this.service.env.DEEPSEEK_BASE_URL || "http://127.0.0.1:8788",
        DEEPSEEK_MODEL: this.service.env.DEEPSEEK_MODEL || "deepseek-flash",
      };
    }
    const run = await this.service.runObservations({
      provider,
      limit,
      queryIds,
      platform,
      concurrency: 2,
    });
    const samples = this.store.listSamples({
      runId: run.runId,
      limit: 1000,
    });
    return {
      ...run,
      samples,
      receipt: {
        synced: run.successful > 0,
        mode: run.dataMode === "fixture" ? "simulated" : "real",
        verifiedAt: new Date().toISOString(),
        snapshotUri: `geo-personal://run/${run.runId}`,
      },
      responseHash: hashObject({
        runId: run.runId,
        status: run.status,
        successful: run.successful,
        failed: run.failed,
        metrics: run.metrics,
      }),
    };
  }

  generateArticles(options) {
    return this.service.generateArticles(options);
  }

  listArticles(limit = 100) {
    const articles = this.store.listArticles(limit);
    if (!this.aiApproval) return articles;
    const latest = this.store.db.prepare(`SELECT receipt_json FROM pengmanager_article_reviews
      WHERE article_id=? AND markdown_sha256=? ORDER BY rowid DESC LIMIT 1`);
    return articles.map(article => {
      const row = latest.get(article.id, hashText(article.markdown));
      if (!row || article.status !== "draft" || article.data_mode !== "draft") return article;
      const receipt = JSON.parse(row.receipt_json);
      try {
        const current = hashObject(this.#articleReviewEvidence(article.id, receipt.sampleIds));
        return current === receipt.snapshotHash ? { ...article, editorialReview: receipt } : article;
      } catch (error) {
        if (error.code === "GEO_ARTICLE_SAMPLE_INVALID") return article;
        throw error;
      }
    });
  }

  #articleReviewEvidence(articleId, sampleIds) {
    const article = this.store.getArticle(articleId);
    if (!article) throw new ApiError(404, "GEO_ARTICLE_NOT_FOUND", "找不到原 GEO 草稿。");
    if (article.data_mode !== "draft" || article.status !== "draft") {
      throw new ApiError(409, "GEO_ARTICLE_NOT_DRAFT", "只能审核仍处于草稿状态的真实 GEO 正文。");
    }
    const contentHash = hashText(article.markdown);
    if (contentHash !== article.evidence_hash) {
      throw new ApiError(409, "GEO_ARTICLE_BYTES_CHANGED", "GEO 草稿正文与登记的实际摘要不符。");
    }
    const lookup = this.store.db.prepare(`SELECT s.id, s.query_id, s.captured_at, s.platform, s.provider, s.model,
      s.data_mode, s.answer, s.citations_json, s.evidence_hash, s.status,
      COALESCE(json_extract(s.analysis_json, '$.query'), q.text) AS query_text
      FROM samples s JOIN queries q ON q.id=s.query_id WHERE s.id=?`);
    const samples = sampleIds.map(sampleId => {
      const row = lookup.get(sampleId);
      if (!row || !article.queryIds.includes(row.query_id) || !["real", "imported"].includes(row.data_mode)
          || row.status !== "success" || !/^[a-f0-9]{64}$/.test(row.evidence_hash ?? "")) {
        throw new ApiError(409, "GEO_ARTICLE_SAMPLE_INVALID", "证据必须来自该原稿的真实或已导入样本。");
      }
      return { id: row.id, queryId: row.query_id, query: row.query_text, platform: row.platform, provider: row.provider,
        model: row.model, dataMode: row.data_mode, capturedAt: row.captured_at, answer: row.answer,
        citations: JSON.parse(row.citations_json), hash: row.evidence_hash };
    });
    return { article: { id: article.id, topicId: article.topic_id, title: article.title, body: article.markdown,
      slug: article.slug, contentHash, dataMode: article.data_mode, queryIds: article.queryIds }, samples };
  }

  async reviewArticle(articleId, input, ctx) {
    if (!["local", "session"].includes(ctx?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "GEO 草稿审核仅允许管理会话。");
    if (!this.aiApproval) throw new ApiError(503, "AI_APPROVAL_WORKER_REQUIRED", "GEO 草稿尚未配置 AI 审核工位。");
    const { sampleIds = [], contentHash, reviewProof } = input;
    if (Object.keys(input).some(key => !["sampleIds", "contentHash", "reviewProof"].includes(key))
        || !/^[a-f0-9]{64}$/.test(contentHash ?? "") || !Array.isArray(sampleIds) || sampleIds.length > 8
        || sampleIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
        || new Set(sampleIds).size !== sampleIds.length) {
      throw new ApiError(400, "GEO_ARTICLE_REVIEW_INPUT_INVALID", "请指定原稿实际摘要及不重复的证据编号。");
    }
    const sortedSampleIds = [...sampleIds].sort();
    const evidence = this.#articleReviewEvidence(articleId, sortedSampleIds);
    if (evidence.article.contentHash !== contentHash) {
      throw new ApiError(412, "PRECONDITION_FAILED", "GEO 草稿已变化，请刷新并核对原稿摘要。");
    }
    const snapshotHash = hashObject(evidence);
    const previous = this.store.db.prepare(`SELECT receipt_json FROM pengmanager_article_reviews
      WHERE article_id=? AND snapshot_hash=?`);
    const prior = previous.get(articleId, snapshotHash);
    if (prior) return JSON.parse(prior.receipt_json);
    const review = await reviewOperationEvidence(this.aiApproval, { kind: "embedded_geo_article", subjectId: articleId,
      evidence, proof: reviewProof, criteria: [
        "逐段审核完整 GEO 文章的事实、来源、样本范围和方法局限。模拟数据不能支撑真实实测结论。",
        "检查措辞、客户或个人信息、可公开性和可追溯性。保留证据缺口，审核结果仅用于后续编辑准备。",
      ] });
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      assertOperationReviewCurrent(review, this.#articleReviewEvidence(articleId, sortedSampleIds));
      this.store.db.prepare(`INSERT INTO pengmanager_article_reviews
        (article_id, snapshot_hash, markdown_sha256, receipt_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(article_id, snapshot_hash) DO NOTHING`).run(articleId, snapshotHash, contentHash,
        JSON.stringify({ status: "reviewed_for_editorial", articleId, contentHash, snapshotHash, sampleIds: sortedSampleIds, aiReview: review.aiReview }));
      const result = JSON.parse(previous.get(articleId, snapshotHash).receipt_json);
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(limit = 20) {
    return this.store.listRuns(limit);
  }

  close() {
    this.store.close();
  }
}
