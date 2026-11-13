CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"source" text,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_role_check" CHECK ("api_keys"."role" in ('source', 'admin')),
	CONSTRAINT "api_keys_source_required_for_source_role" CHECK (("api_keys"."role" = 'source') = ("api_keys"."source" is not null))
);
