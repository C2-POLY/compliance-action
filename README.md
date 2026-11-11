# compliance-action

A GitHub Action that keeps a repo's compliance manifest in step with its code. It checks `.compliance/manifest.yaml` on pull requests, and on every merge sends the manifest and the commit SHA to the organisation's compliance repo, together with how far the documents lag behind the code.

> **Status: not released yet.** The usage below is the target for `v1`.

```yaml
- uses: C2-POLY/compliance-action@v1
  with:
    mode: check
```

The format of the manifest and of the compliance repo is defined in [compliance-spec](https://github.com/C2-POLY/compliance-spec).

## Disclaimer

This action prepares documentation. It does not certify compliance and does not replace a Data Protection Officer.

## Licence

[Apache 2.0](LICENSE)
