"""BTC trend-ride bot for the bars-replay/v1 harness.

Strategy (kept deliberately simple, few parameters, fully deterministic):
  * Enter with all cash on the first batch.
  * While holding, track the highest close since entry.
  * Sell everything when the close falls 3% below that peak, or, once a
    360-bar history exists, when the close falls 0.5% below the 360-bar
    exponential moving average.
  * While flat and a 360-bar history exists, buy back with all cash when
    the close rises above the 360-bar EMA.
Round trips are expensive in this replay (fees, slippage and price impact),
so the bot trades rarely and otherwise just rides the trend.
"""

import json
import sys

SYMBOL = "CBBTC"
SLOW_N = 360            # EMA length in bars (minutes)
EXIT_EMA_MULT = 0.995   # sell when close < EMA * this
PEAK_DROP = 0.03        # sell when close < peak since entry * (1 - this)
MAX_SLIPPAGE_BPS = 500  # generous, so fast moves do not reject the order


class Bot:
    def __init__(self, hello):
        self.hello = hello
        self.warmup = int(hello.get("warmup_bars", 0))
        self.closes = []
        self.ema = None
        self.ema_k = 2.0 / (SLOW_N + 1)
        self.peak = None        # highest close since the position opened
        self.holding = False
        self.entered_once = False
        self.buy_count = 0
        self.sell_count = 0

    def on_batch(self, batch):
        seq = batch["seq"]
        bar = None
        for b in batch["bars"]:
            if b["symbol"] == SYMBOL:
                bar = b
        account = batch["account"]
        cash = int(account["cash_quote_units"])
        qty = 0
        for p in account["positions"]:
            if p["symbol"] == SYMBOL:
                qty = int(p["qty"])
        was_holding = self.holding
        self.holding = qty > 0
        if bar is None:
            return []
        close = int(bar["c"])
        self.closes.append(close)
        if self.ema is None:
            self.ema = float(close)
        else:
            self.ema += self.ema_k * (close - self.ema)
        if self.holding:
            if not was_holding or self.peak is None:
                self.peak = close
            elif close > self.peak:
                self.peak = close
        else:
            self.peak = None
        if seq < self.warmup:
            return []
        n = len(self.closes)
        orders = []
        if not self.holding:
            enter = (not self.entered_once) or (n > SLOW_N and close > self.ema)
            if enter and cash >= 1_000_000:
                self.entered_once = True
                self.buy_count += 1
                orders.append({
                    "side": "buy",
                    "client_id": f"b{self.buy_count}",
                    "symbol": SYMBOL,
                    "notional_quote_units": str(cash),
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                })
        else:
            drop_exit = self.peak is not None and close < self.peak * (1.0 - PEAK_DROP)
            ema_exit = n > SLOW_N and close < self.ema * EXIT_EMA_MULT
            if drop_exit or ema_exit:
                self.sell_count += 1
                orders.append({
                    "side": "sell",
                    "client_id": f"s{self.sell_count}",
                    "symbol": SYMBOL,
                    "qty": str(qty),
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                })
        return orders


def main():
    bot = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            bot = Bot(msg)
        elif kind == "batch":
            orders = bot.on_batch(msg)
            reply = {"type": "reply", "seq": msg["seq"], "orders": orders}
            out.write(json.dumps(reply, separators=(",", ":")) + "\n")
            out.flush()
        elif kind == "done":
            break


if __name__ == "__main__":
    main()
