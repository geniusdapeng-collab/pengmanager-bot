# GEO evidence engine

This directory adapts the Apache-2.0 GeoEvidence Studio distribution. It keeps the SQLite query store, evidence records, citation analysis, metrics, article drafts and local export. The bundled 100-question front-desk regression case is fictional. The default personal case and the independent control-plane queries have separate IDs.

`fixture` runs without a model and stays explicitly labelled as synthetic. `deepseek` collects model answers using the deployment's configured provider. `deepseek-search` additionally depends on a configured compatible search endpoint. The provider and actual results are recorded on each sample. Imported answers keep their import provenance.

```sh
node engines/geo-evidence/cli.mjs run --provider fixture --limit 1
node engines/geo-evidence/cli.mjs run --provider deepseek-search --limit 1 --confirm
```

For a real run, configure the authorized endpoint and credential in the process environment. The standalone HTTP service defaults to loopback and requires an owner token plus explicit confirmation for live observations. Use the CLI for approved local answer imports. Drafts export to local files. External publishing is handled by separately authorized BOT channels.
