/**
 * BTC trend-ride bot for the bars-replay/v1 harness.
 *
 * Strategy (kept deliberately simple, few parameters, fully deterministic):
 *   - Enter with all cash on the first batch.
 *   - While holding, track the highest close since entry.
 *   - Sell everything when the close falls 3% below that peak, or, once a
 *     360-bar history exists, when the close falls 0.5% below the 360-bar
 *     exponential moving average.
 *   - While flat and a 360-bar history exists, buy back with all cash when
 *     the close rises above the 360-bar EMA.
 * Round trips are expensive in this replay (fees, slippage and price
 * impact), so the bot trades rarely and otherwise just rides the trend.
 */
import { createInterface } from "node:readline";

const SYMBOL = "CBBTC";
const SLOW_N = 360; // EMA length in bars (minutes)
const EXIT_EMA_MULT = 0.995; // sell when close < EMA * this
const PEAK_DROP = 0.03; // sell when close < peak since entry * (1 - this)
const MAX_SLIPPAGE_BPS = 500; // generous, so fast moves do not reject orders
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

type Order = {
  side: string;
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

class Bot {
  warmup = 0;
  closes: number[] = [];
  ema: number | null = null;
  emaK = 2.0 / (SLOW_N + 1);
  peak: number | null = null; // highest close since the position opened
  holding = false;
  enteredOnce = false;
  buyCount = 0;
  sellCount = 0;

  constructor(hello: any) {
    this.warmup = Number(hello["warmup_bars"] ?? 0);
  }

  onBatch(batch: any): Order[] {
    const seq: number = batch["seq"];
    let bar: any = null;
    for (const b of batch["bars"]) {
      if (b["symbol"] === SYMBOL) bar = b;
    }
    const account = batch["account"];
    const cash = BigInt(account["cash_quote_units"]);
    let qty = 0n;
    for (const p of account["positions"]) {
      if (p["symbol"] === SYMBOL) qty = BigInt(p["qty"]);
    }
    const wasHolding = this.holding;
    this.holding = qty > 0n;
    if (bar === null) return [];
    const close = Number(bar["c"]);
    this.closes.push(close);
    if (this.ema === null) {
      this.ema = close;
    } else {
      this.ema += this.emaK * (close - this.ema);
    }
    if (this.holding) {
      if (!wasHolding || this.peak === null) {
        this.peak = close;
      } else if (close > this.peak) {
        this.peak = close;
      }
    } else {
      this.peak = null;
    }
    if (seq < this.warmup) return [];
    const n = this.closes.length;
    const orders: Order[] = [];
    if (!this.holding) {
      const enter = !this.enteredOnce || (n > SLOW_N && close > (this.ema as number));
      if (enter && cash >= MIN_NOTIONAL) {
        this.enteredOnce = true;
        this.buyCount += 1;
        orders.push({
          side: "buy",
          client_id: `b${this.buyCount}`,
          symbol: SYMBOL,
          notional_quote_units: cash.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else {
      const dropExit = this.peak !== null && close < this.peak * (1.0 - PEAK_DROP);
      const emaExit = n > SLOW_N && close < (this.ema as number) * EXIT_EMA_MULT;
      if (dropExit || emaExit) {
        this.sellCount += 1;
        orders.push({
          side: "sell",
          client_id: `s${this.sellCount}`,
          symbol: SYMBOL,
          qty: qty.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
    return orders;
  }
}

let bot: Bot | null = null;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg["type"] === "hello") {
    bot = new Bot(msg);
  } else if (msg["type"] === "batch") {
    const orders = (bot as Bot).onBatch(msg);
    const reply = { type: "reply", seq: msg["seq"], orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
  } else if (msg["type"] === "done") {
    rl.close();
  }
});
