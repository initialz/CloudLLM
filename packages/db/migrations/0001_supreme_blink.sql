ALTER TABLE "usage_records" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_event_id_unique" UNIQUE("event_id");