// watchlists.js — curated theme lists for the Income & Growth screener.
// Yields/notes are approximate and for orientation only — always verify current
// figures before investing. Clicking any item runs the full signal analysis.

export const WATCHLISTS = [
  {
    id: "high-dividend",
    title: "High-Dividend Income",
    blurb: "Higher current yield for income-focused investors.",
    items: [
      { symbol: "SCHD", name: "Schwab US Dividend Equity ETF", note: "~3.5% yield · quality dividend growth" },
      { symbol: "VYM", name: "Vanguard High Dividend Yield ETF", note: "~2.8% yield · broad large-cap" },
      { symbol: "JEPI", name: "JPMorgan Equity Premium Income", note: "~7–9% yield · covered-call income" },
      { symbol: "JEPQ", name: "JPMorgan Nasdaq Equity Premium", note: "~9–11% yield · tech-tilted income" },
      { symbol: "O", name: "Realty Income (REIT)", note: "~5% yield · monthly dividend" },
      { symbol: "SPHD", name: "Invesco S&P 500 High Div Low Vol", note: "~4% yield · low volatility" },
      { symbol: "VZ", name: "Verizon", note: "~6% yield · telecom" },
      { symbol: "MO", name: "Altria", note: "~8% yield · consumer staples" },
    ],
  },
  {
    id: "dividend-growth",
    title: "Dividend Growth (Aristocrats)",
    blurb: "Lower current yield, but a long history of raising payouts.",
    items: [
      { symbol: "KO", name: "Coca-Cola", note: "~3% yield · 60+ yrs of raises" },
      { symbol: "PEP", name: "PepsiCo", note: "~3% yield · staples" },
      { symbol: "JNJ", name: "Johnson & Johnson", note: "~3% yield · healthcare" },
      { symbol: "PG", name: "Procter & Gamble", note: "~2.5% yield · staples" },
      { symbol: "HD", name: "Home Depot", note: "~2.5% yield · retail" },
      { symbol: "NOBL", name: "ProShares S&P 500 Dividend Aristocrats", note: "ETF of aristocrats" },
      { symbol: "VIG", name: "Vanguard Dividend Appreciation ETF", note: "dividend-growth ETF" },
    ],
  },
  {
    id: "growth-etfs",
    title: "Long-Term Growth ETFs & Funds",
    blurb: "Broad, low-cost building blocks for long-term compounding.",
    items: [
      { symbol: "VOO", name: "Vanguard S&P 500 ETF", note: "0.03% fee · US large-cap" },
      { symbol: "VTI", name: "Vanguard Total Stock Market ETF", note: "0.03% fee · entire US market" },
      { symbol: "QQQ", name: "Invesco Nasdaq 100 ETF", note: "tech-heavy growth" },
      { symbol: "VUG", name: "Vanguard Growth ETF", note: "US large-cap growth" },
      { symbol: "SCHG", name: "Schwab US Large-Cap Growth", note: "low-fee growth" },
      { symbol: "VXUS", name: "Vanguard Total International Stock", note: "ex-US diversification" },
      { symbol: "VT", name: "Vanguard Total World Stock ETF", note: "whole-world equity" },
    ],
  },
  {
    id: "thematic-growth",
    title: "Thematic / Sector Growth",
    blurb: "Higher risk, higher potential — concentrated bets.",
    items: [
      { symbol: "SMH", name: "VanEck Semiconductor ETF", note: "chips" },
      { symbol: "SOXX", name: "iShares Semiconductor ETF", note: "chips" },
      { symbol: "XLK", name: "Technology Select Sector SPDR", note: "US tech" },
      { symbol: "ARKK", name: "ARK Innovation ETF", note: "disruptive innovation · volatile" },
      { symbol: "ICLN", name: "iShares Global Clean Energy", note: "clean energy" },
      { symbol: "XLV", name: "Health Care Select Sector SPDR", note: "healthcare" },
    ],
  },
];
