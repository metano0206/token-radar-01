# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/metano0206/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/metano0206/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's token-radar-01 bounty. It reads one sealed snapshot of
every protocol DefiLlama tracks, works out which ones still record no token and are not a
wrapped, staked, bridged or versioned product of one that trades, ranks them by what their
launch would be worth, and presents the board as a static dashboard with a detail view and a
farm plan for every protocol.

## Run it

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only; nothing is installed. The program writes
`board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output
directory, and writes the same bytes on every run. Open `dashboard/index.html` from the
output directory to read the board; it renders with no network.

## The model

Implied value = TVL × peer multiple × growth factor × maturity factor, all from the
snapshot's own figures:

- **Peer multiple** — the median market-cap/TVL of the snapshot's tokenized protocols in the
  same category, shrunk toward the global median when a category has few peers.
- **Growth** — the seven-day TVL change, clamped to −50%…+100%, moves the price by up to
  ±35%. No reported change reads as no signal.
- **Maturity** — how long the protocol has run with no token, on a 0.75–1.00 scale over five
  years.

The board's universe is every protocol that records no token (no CoinGecko id, no symbol)
and passes the product screen at any TVL: the snapshot's 40-protocol watchlist is the floor
of the board, never its ceiling. The model is `lib/model.ts`; no protocol name is ever
special-cased.

## Layout

- `main.ts` — the program: snapshot in, outputs out.
- `lib/model.ts` — the filter, the value model, the farm plans, the board self-check.
- `vendor/makefun-board.ts` — make.fun's dossier library, as the kit ships it.
- `dashboard/` — the static page (index.html, app.css, app.js).
- `screenshots/` — the board, a detail view and a filtered view, captured from this page.

MIT licensed; see LICENSE.
