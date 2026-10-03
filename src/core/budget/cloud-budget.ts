import type Database from 'better-sqlite3';

/**
 * Security remediation R-05: a daily cap on estimated cloud spend (model API
 * calls + cloud media providers), per UTC day. When the cap is reached, the
 * model router and media service stop selecting CLOUD providers (local ones
 * keep working). Estimates come from each provider's own cost estimate
 * (`estimatedApiCost`); unknown estimates count as 0, so the cap is a guard
 * rail, not an invoice.
 */
export class CloudBudget {
  constructor(
    private readonly sqlite: Database.Database,
    readonly dailyLimitUsd: number,
    private readonly now: () => Date = () => new Date(),
    /** Re-audit R2-05: worst-case USD charged for a cloud call whose price is unknown (unlisted model, ElevenLabs). */
    readonly unpricedCallUsd = 0.05,
  ) {}

  /** Start of the current UTC day as stored in `created_at` columns. */
  private dayStart(): string {
    const d = this.now();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  spentTodayUsd(): { models: number; media: number; total: number; unpricedCalls: number } {
    const since = this.dayStart();
    const m = this.sqlite
      .prepare("SELECT COALESCE(SUM(estimated_api_cost), 0) AS usd, SUM(CASE WHEN estimated_api_cost IS NULL THEN 1 ELSE 0 END) AS unpriced FROM model_runs WHERE execution_cost_type = 'API' AND created_at >= ?")
      .get(since) as { usd: number; unpriced: number | null };
    const a = this.sqlite
      .prepare(
        "SELECT COALESCE(SUM(CAST(json_extract(cost, '$.estimatedApiCost') AS REAL)), 0) AS usd, SUM(CASE WHEN json_extract(cost, '$.estimatedApiCost') IS NULL THEN 1 ELSE 0 END) AS unpriced FROM media_assets WHERE provider_kind = 'CLOUD' AND created_at >= ?",
      )
      .get(since) as { usd: number; unpriced: number | null };
    // Unknown prices count at the configured worst case, never as $0 (re-audit N-05).
    const models = m.usd + (m.unpriced ?? 0) * this.unpricedCallUsd;
    const media = a.usd + (a.unpriced ?? 0) * this.unpricedCallUsd;
    return { models, media, total: models + media, unpricedCalls: (m.unpriced ?? 0) + (a.unpriced ?? 0) };
  }

  /** Null while cloud spend is allowed; otherwise why cloud providers are excluded. */
  exhaustedReason(): string | null {
    if (this.dailyLimitUsd <= 0) return 'CLOUD_BUDGET: cloud providers disabled (JOVI_DAILY_CLOUD_BUDGET_USD=0)';
    const spent = this.spentTodayUsd().total;
    if (spent >= this.dailyLimitUsd) return `CLOUD_BUDGET: daily cloud budget reached ($${spent.toFixed(2)} of $${this.dailyLimitUsd.toFixed(2)}, UTC day)`;
    return null;
  }
}
