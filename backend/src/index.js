const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_PRICE_URL =
  "https://api.realmarketapi.com/api/v1/price";

const MARKET_CANDLE_URL =
  "https://api.realmarketapi.com/api/v1/candle";

const TIMEFRAMES = ["M1", "M5", "H1"];

// RESPONSE

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    }
  });
}

// CANDLE NORMALIZATION

function normalizeCandle(c) {
  return {
    open: Number(c.OpenPrice ?? c.openPrice ?? c.open),
    high: Number(c.HighPrice ?? c.highPrice ?? c.high),
    low: Number(c.LowPrice ?? c.lowPrice ?? c.low),
    close: Number(c.ClosePrice ?? c.closePrice ?? c.close),
    volume: Number(c.Volume ?? c.volume ?? 0),
    time: c.OpenTime ?? c.openTime ?? c.time
  };
}

function validCandle(c) {
  const values = [
    c.open,
    c.high,
    c.low,
    c.close
  ];

  return (
    values.every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low &&
    Number.isFinite(Date.parse(c.time))
  );
}

// FETCH MARKET CANDLES

async function getCandles(env, timeframe) {

  const params = new URLSearchParams({
    apiKey: env.REALMARKETAPI_KEY,
    symbolCode: "XAUUSD",
    timeFrame: timeframe
  });

  const result = await fetch(
    `${MARKET_CANDLE_URL}?${params}`
  );

  if (!result.ok) {
    throw new Error(
      `Market provider returned ${result.status}`
    );
  }

  const raw = await result.json();

  const rows = Array.isArray(raw)
    ? raw
    : raw.Data ?? raw.data ?? [];

  if (!Array.isArray(rows)) {
    throw new Error("Invalid candle response");
  }

  const candles = rows
    .map(normalizeCandle)
    .filter(validCandle)
    .sort(
      (a, b) =>
        Date.parse(a.time) - Date.parse(b.time)
    );

  const unique = candles.filter(
    (c, index, array) =>
      index === 0 ||
      c.time !== array[index - 1].time
  );

  if (unique.length < 50) {
    throw new Error(
      `At least 50 valid candles required. Received ${unique.length}.`
    );
  }

  return unique.slice(-300);
}

// EMA CALCULATION

function calculateEMA(values, period) {

  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema =
      values[i] * multiplier +
      ema * (1 - multiplier);
  }

  return ema;
}

// RSI CALCULATION

function calculateRSI(values, period = 14) {

  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    if (change < 0) losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {

    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

// MACD CALCULATION

function calculateMACD(values) {

  if (values.length < 35) {
    return null;
  }

  const macdSeries = [];

  for (let i = 25; i < values.length; i++) {

    const section = values.slice(0, i + 1);

    const fast = calculateEMA(section, 12);
    const slow = calculateEMA(section, 26);

    if (fast !== null && slow !== null) {
      macdSeries.push(fast - slow);
    }
  }

  if (macdSeries.length < 9) {
    return null;
  }

  const macd = macdSeries[macdSeries.length - 1];

  const signal = calculateEMA(macdSeries, 9);

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// ATR CALCULATION

function calculateATR(candles, period = 14) {

  if (candles.length <= period) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {

    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    ranges.push(tr);
  }

  let atr = ranges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < ranges.length; i++) {
    atr =
      (atr * (period - 1) + ranges[i]) / period;
  }

  return atr;
}

// MARKET STRUCTURE

function calculateStructure(candles) {

  const recent = candles.slice(-20);
  const previous = candles.slice(-40, -20);

  if (recent.length < 20 || previous.length < 20) {
    return null;
  }

  const recentHigh = Math.max(
    ...recent.map(c => c.high)
  );

  const recentLow = Math.min(
    ...recent.map(c => c.low)
  );

  const previousHigh = Math.max(
    ...previous.map(c => c.high)
  );

  const previousLow = Math.min(
    ...previous.map(c => c.low)
  );

  const lastClose = candles[candles.length - 1].close;

  let structure = "RANGE";

  if (lastClose > previousHigh) {
    structure = "BULLISH BREAKOUT";
  } else if (lastClose < previousLow) {
    structure = "BEARISH BREAKOUT";
  } else if (
    recentHigh > previousHigh &&
    recentLow > previousLow
  ) {
    structure = "HIGHER HIGHS AND HIGHER LOWS";
  } else if (
    recentHigh < previousHigh &&
    recentLow < previousLow
  ) {
    structure = "LOWER HIGHS AND LOWER LOWS";
  }

  return {
    recent_high: recentHigh,
    recent_low: recentLow,
    previous_high: previousHigh,
    previous_low: previousLow,
    structure
  };
}

// COMPLETE TECHNICAL ANALYSIS

function calculateIndicators(candles) {

  const closes = candles.map(c => c.close);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  const rsi = calculateRSI(closes, 14);

  const macd = calculateMACD(closes);

  const atr = calculateATR(candles, 14);

  const structure = calculateStructure(candles);

  const latest = closes[closes.length - 1];

  let trend = "SIDEWAYS";

  if (ema20 > ema50 && latest > ema20) {
    trend = "BULLISH";
  } else if (ema20 < ema50 && latest < ema20) {
    trend = "BEARISH";
  }

  let momentum = "NEUTRAL";

  if (macd && macd.histogram > 0) {
    momentum = "BULLISH";
  } else if (macd && macd.histogram < 0) {
    momentum = "BEARISH";
  }

  let rsiCondition = "NEUTRAL";

  if (rsi >= 70) {
    rsiCondition = "OVERBOUGHT";
  } else if (rsi <= 30) {
    rsiCondition = "OVERSOLD";
  }

  return {
    latest_price: latest,

    ema: {
      ema20,
      ema50
    },

    rsi: {
      value: rsi,
      condition: rsiCondition
    },

    macd,

    atr,

    trend,

    momentum,

    market_structure: structure
  };
}

// AI ANALYSIS

async function analyzeCandles(
  env,
  candles,
  timeframe
) {

  const indicators = calculateIndicators(candles);

  const aiResponse = await fetch(TCHAVI_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.TCHAVI_API_KEY}`
    },

    body: JSON.stringify({

      model: "gpt-4o-mini",

      temperature: 0.2,

      messages: [

        {
          role: "system",

          content: `
You are SIR BOT AI, an advanced XAUUSD market analysis assistant.

Analyze the supplied genuine OHLCV candles and mathematically calculated indicators.

Evaluate:

1. EMA20 and EMA50 trend alignment.
2. RSI 14 momentum and overbought/oversold conditions.
3. MACD momentum and histogram.
4. ATR volatility.
5. Recent market structure.
6. Recent price action.
7. Agreement or disagreement between indicators.

IMPORTANT RULES:

- Do not automatically BUY because RSI is oversold.
- Do not automatically SELL because RSI is overbought.
- Require multiple confirming factors.
- Identify conflicting indicators.
- Choose WAIT when evidence is insufficient.
- Do not invent prices or indicators.
- Do not promise profits.
- Never claim to execute trades.
- Confidence must reflect evidence quality, not certainty.
- A high confidence score does not guarantee a successful trade.

Return ONLY valid JSON:

{
  "decision": "BUY, SELL, or WAIT",
  "confidence": 0,
  "trend": "BULLISH, BEARISH, or SIDEWAYS",
  "reasoning": "Detailed explanation",
  "risk_warning": "Trading involves risk"
}
`
        },

        {
          role: "user",

          content: JSON.stringify({

            market: "XAUUSD",

            timeframe,

            candle_count: candles.length,

            candles,

            indicators

          })
        }

      ]

    })

  });

  if (!aiResponse.ok) {
    throw new Error(
      `Tchavi returned ${aiResponse.status}`
    );
  }

  const result = await aiResponse.json();

  const content =
    result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty AI response");
  }

  const analysis = JSON.parse(
    content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim()
  );

  if (
    !["BUY", "SELL", "WAIT"].includes(analysis.decision) ||

    !Number.isFinite(analysis.confidence) ||

    analysis.confidence < 0 ||

    analysis.confidence > 100 ||

    !["BULLISH", "BEARISH", "SIDEWAYS"].includes(analysis.trend)
  ) {
    throw new Error("Invalid AI analysis");
  }

  return {
    analysis,
    indicators
  };
}

// MAIN WORKER

export default {

  async fetch(request
