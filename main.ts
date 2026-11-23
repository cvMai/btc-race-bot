/**
 * BTC trading bot for a bars replay race.
 *
 * Idea: ride the trend and trade as rarely as possible, because every
 * round trip pays fees and slippage in this replay.
 *
 * Rules the bot follows:
 *   - On the first usable batch it buys with all of its cash.
 *   - While it holds BTC it remembers the highest close since entry.
 *   - It sells everything if the close drops 3 percent below that peak.
 *   - It also sells if, once enough history exists, the close falls
 *     0.5 percent below the slow exponential moving average.
 *   - While it holds no BTC and enough history exists, it buys back
 *     with all cash when the close moves back above that average.
 *
 * The slow average uses 360 bars. One bar is one minute, so the bot
 * reacts to a six hour trend rather than to minute by minute noise.
 * Everything is deterministic: the same batch stream always leads
 * to the same orders.
 */
import { createInterface } from "node:readline";

const TRADED_SYMBOL = "CBBTC";
const SLOW_SPAN = 360;
const PEAK_EXIT_DROP = 0.03;
const AVERAGE_EXIT_FACTOR = 0.995;
const SLIPPAGE_LIMIT_BPS = 500;
const SMALLEST_BUY = 1_000_000n;

type OutgoingOrder = {
  side: string;
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

function readCloseForSymbol(batch: any): number | null {
  let found: number | null = null;
  for (const bar of batch["bars"]) {
    if (bar["symbol"] === TRADED_SYMBOL) {
      found = Number(bar["c"]);
    }
  }
  return found;
}

function readCash(account: any): bigint {
  return BigInt(account["cash_quote_units"]);
}

function readHeldQty(account: any): bigint {
  let held = 0n;
  for (const position of account["positions"]) {
    if (position["symbol"] === TRADED_SYMBOL) {
      held = BigInt(position["qty"]);
    }
  }
  return held;
}

class TrendRideBot {
  private warmupBars = 0;
  private barsSeen = 0;
  private average: number | null = null;
  private readonly smoothing = 2.0 / (SLOW_SPAN + 1);
  private peakSinceEntry: number | null = null;
  private holdingNow = false;
  private boughtBefore = false;
  private buyNumber = 0;
  private sellNumber = 0;

  constructor(hello: any) {
    this.warmupBars = Number(hello["warmup_bars"] ?? 0);
  }

  private updateAverage(close: number): void {
    if (this.average === null) {
      this.average = close;
      return;
    }
    this.average = this.average + this.smoothing * (close - this.average);
  }

  private trackPeak(close: number, wasHolding: boolean): void {
    if (!this.holdingNow) {
      this.peakSinceEntry = null;
      return;
    }
    if (!wasHolding || this.peakSinceEntry === null) {
      this.peakSinceEntry = close;
      return;
    }
    if (close > this.peakSinceEntry) {
      this.peakSinceEntry = close;
    }
  }

  private isUsableClose(close: number): boolean {
    return Number.isFinite(close) && close > 0;
  }

  private shouldEnter(close: number): boolean {
    if (!this.boughtBefore) return true;
    if (this.barsSeen <= SLOW_SPAN) return false;
    if (this.average === null) return false;
    return close > this.average;
  }

  private shouldExit(close: number): boolean {
    if (this.peakSinceEntry !== null) {
      const peakLimit = this.peakSinceEntry * (1.0 - PEAK_EXIT_DROP);
      if (close < peakLimit) return true;
    }
    if (this.barsSeen > SLOW_SPAN && this.average !== null) {
      if (close < this.average * AVERAGE_EXIT_FACTOR) return true;
    }
    return false;
  }

  onBatch(batch: any): OutgoingOrder[] {
    const seq: number = batch["seq"];
    const close = readCloseForSymbol(batch);
    const account = batch["account"];
    const cash = readCash(account);
    const heldQty = readHeldQty(account);
    const wasHolding = this.holdingNow;
    this.holdingNow = heldQty > 0n;
    if (close === null || !this.isUsableClose(close)) return [];
    this.barsSeen += 1;
    this.updateAverage(close);
    this.trackPeak(close, wasHolding);
    if (seq < this.warmupBars) return [];
    const orders: OutgoingOrder[] = [];
    if (!this.holdingNow) {
      if (this.shouldEnter(close) && cash >= SMALLEST_BUY) {
        this.boughtBefore = true;
        this.buyNumber += 1;
        orders.push({
          side: "buy",
          client_id: `buy-${this.buyNumber}`,
          symbol: TRADED_SYMBOL,
          notional_quote_units: cash.toString(),
          max_slippage_bps: SLIPPAGE_LIMIT_BPS,
        });
      }
      return orders;
    }
    if (this.shouldExit(close)) {
      this.sellNumber += 1;
      orders.push({
        side: "sell",
        client_id: `sell-${this.sellNumber}`,
        symbol: TRADED_SYMBOL,
        qty: heldQty.toString(),
        max_slippage_bps: SLIPPAGE_LIMIT_BPS,
      });
    }
    return orders;
  }
}

let activeBot: TrendRideBot | null = null;
const lineReader = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
lineReader.on("line", (rawLine: string) => {
  const line = rawLine.trim();
  if (line.length === 0) return;
  const message = JSON.parse(line);
  if (message["type"] === "hello") {
    activeBot = new TrendRideBot(message);
  } else if (message["type"] === "batch") {
    const orders = (activeBot as TrendRideBot).onBatch(message);
    const reply = { type: "reply", seq: message["seq"], orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
  } else if (message["type"] === "done") {
    lineReader.close();
  }
});
