# Prototype wallet

A browser wallet for the PaSta prototype chain, served at `pastacoin.org/prototype/`. Plain
HTML, CSS and JavaScript modules; no build step.

| File | What it is |
|---|---|
| `index.html`, `css/styles.css` | The page. Same design tokens as `/results/`. |
| `js/app.js` | The wallet: node API calls, polling, rendering. |
| `js/pasta-crypto.js` | Keys, canonical payload, signing, Base58, exact amount conversion. Must agree with `pasta/core/crypto.py` and `pasta/core/units.py` in `pastacoin/pastacoin`. |
| `js/vendor/noble-secp256k1.js` | secp256k1, vendored (see below). |

## What it talks to

One PaSta node, over the REST API in `docs/SPEC.md` section 10 of `pastacoin/pastacoin`
(integer base units, mint set at finalization: the API as of the launch mint rule).

The node address is one constant, `DEFAULT_NODE` at the top of `js/app.js`, currently
`http://localhost:5000`. Change it to the public seed when one exists. A visitor can override
it with `?node=https://…` or the “Change node” button; the choice is remembered in the
browser.

When the page is served over HTTPS and the node is `http://localhost`, the browser treats it
as a request to the local network: Chrome asks the visitor for permission, and Safari refuses.
A public HTTPS node has no such problem.

## Keys

Wallets are created in the browser and stored in its `localStorage` (`pasta.wallets`). The
private key is never sent anywhere; the node receives signed transactions only. The backup
file has the same shape as the node's `genesis-wallet.json`, so either can be imported.

## Vendored library

`js/vendor/noble-secp256k1.js` is `index.js` from the npm package `@noble/secp256k1` version
2.3.0, unmodified. MIT licence (`js/vendor/noble-secp256k1.LICENSE.txt`), by Paul Miller.
SHA-256 of the file: `8ba6138826758ef7d13243f18f7fbf8b26c81c6abea706e692baa83dfe3827e1`.
Its README says version 2 has not itself been independently audited: it is a rewrite of
version 1, which Cure53 audited in 2021, and it is cross-tested against the audited
noble-curves. Good enough for test coins; revisit before anything of value depends on it.

## Trying it locally

    # in a clone of pastacoin/pastacoin
    python node.py --storage chain.json          # writes genesis-wallet.json for a new chain
    # in this repository
    python -m http.server 8000
    # then open http://localhost:8000/prototype/ and import genesis-wallet.json
