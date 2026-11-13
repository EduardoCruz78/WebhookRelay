CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deliveries_event_subscription_unique" UNIQUE("event_id","subscription_id"),
	CONSTRAINT "deliveries_status_check" CHECK ("deliveries"."status" in ('pending', 'failed', 'succeeded', 'dead')),
	CONSTRAINT "deliveries_attempts_check" CHECK ("deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"error" text,
	"response_snippet" text,
	CONSTRAINT "delivery_attempts_attempt_number_check" CHECK ("delivery_attempts"."attempt_number" >= 1),
	CONSTRAINT "delivery_attempts_duration_check" CHECK ("delivery_attempts"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "events_source_idempotency_key_unique" UNIQUE("source","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "subscription_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"event_types" text[] NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscriptions_channel_check" CHECK ("subscriptions"."channel" in ('webhook', 'email', 'telegram')),
	CONSTRAINT "subscriptions_event_types_not_empty" CHECK (cardinality("subscriptions"."event_types") > 0)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_secrets" ADD CONSTRAINT "subscription_secrets_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_status_created_idx" ON "deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "deliveries_subscription_created_idx" ON "deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_attempts_delivery_started_idx" ON "delivery_attempts" USING btree ("delivery_id","started_at");--> statement-breakpoint
CREATE INDEX "events_received_at_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "subscription_secrets_subscription_idx" ON "subscription_secrets" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_active_event_types_idx" ON "subscriptions" USING gin ("event_types") WHERE "subscriptions"."is_active";