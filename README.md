# btc-race-bot

A cbBTC trading bot for the make.fun "Race a BTC trading bot live for 24
hours" bounty (harness: agent-fun/bars-replay/v1). It trades Coinbase
Wrapped BTC against USDC, one decision per 1-minute bar, long only, with
1,000 USDC of paper money.

## Strategy

Round trips in this replay are expensive (a 4 bps fee, 2 bps of modelled
slippage and the order's own price impact on the pool), so the bot trades
rarely and otherwise rides the trend:

- Enter with all cash on the first batch.
- While holding, track the highest close since entry.
- Sell everything when the close falls 3% below that peak, or — once a
  360-bar history exists — when the close falls 0.5% below the 360-bar
  exponential moving average.
- While flat and a 360-bar history exists, buy back with all cash when the
  close rises above the 360-bar EMA.

The bot is fully deterministic: it reads only the bars and account the
harness sends, never the clock, the network or the filesystem.

## Running

The harness runs it as `python3 -P -s main.py` (Python 3.13, standard
library only). It speaks newline-delimited JSON on stdin/stdout: one
`hello`, one `batch` per minute answered by exactly one `reply`, then
`done`.
