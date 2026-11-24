DROP INDEX "audit_issues_crawl_id_code_index";--> statement-breakpoint
DROP INDEX "ga4_landing_daily_project_id_date_index";--> statement-breakpoint
CREATE INDEX "api_ledger_project_id_index" ON "api_ledger" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rank_results_run_id_index" ON "rank_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "rank_tasks_keyword_id_index" ON "rank_tasks" USING btree ("keyword_id");--> statement-breakpoint
CREATE INDEX "ai_overviews_prompt_id_index" ON "ai_overviews" USING btree ("prompt_id");