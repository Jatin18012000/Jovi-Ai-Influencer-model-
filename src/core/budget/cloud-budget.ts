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
  ) {}

  /** Start of the current UTC day as stored in `created_at` columns. */
  private dayStart(): string {
    const d = this.now();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  spentTodayUsd(): { models: number; media: number; total: number } {
    const since = this.dayStart();
    const models = (
      this.sqlite.prepare("SELECT COALESCE(SUM(estimated_api_cost), 0) AS usd FROM model_runs WHERE execution_cost_type = 'API' AND created_at >= ?").get(since) as { usd: number }
    ).usd;
    const media = (
      this.sqlite
        .prepare("SELECT COALESCE(SUM(CAST(json_extract(cost, '$.estimatedApiCost') AS REAL)), 0) AS usd FROM media_assets WHERE provider_kind = 'CLOUD' AND created_at >= ?")
        .get(since) as { usd: number }
    ).usd;
    return { models, media, total: models + media };
  }

  /** Null while cloud spend is allowed; otherwise why cloud providers are excluded. */
  exhaustedReason(): string | null {
    if (this.dailyLimitUsd <= 0) return 'CLOUD_BUDGET: cloud providers disabled (JOVI_DAILY_CLOUD_BUDGET_USD=0)';
    const spent = this.spentTodayUsd().total;
    if (spent >= this.dailyLimitUsd) return `CLOUD_BUDGET: daily cloud budget reached ($${spent.toFixed(2)} of $${this.dailyLimitUsd.toFixed(2)}, UTC day)`;
    return null;
  }
}
