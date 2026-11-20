import { DatabaseSync } from "node:sqlite";

export interface Run {
  id: string;
  /** A string the harness puts in its test email, so a delivery can be tied to that email. */
  nonce: string | null;
  /** The webhook signing secret the agent handed over, if it has. */
  secret: string | null;
  secretAt: string | null;
  createdAt: string;
}

export interface Delivery {
  svixId: string;
  timestamp: string | null;
  signature: string | null;
  /** The exact bytes received: the signature is over these, not over parsed JSON. */
  body: Uint8Array;
  receivedAt: string;
  /** How many times the same delivery id arrived again. */
  repeats: number;
}

export type AddDeliveryResult = "stored" | "duplicate" | "full";

type Row = Record<string, unknown>;

/** Runs and the webhook deliveries each one received. One SQLite file, or ":memory:" in tests. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly maxDeliveriesPerRun: number;

  constructor(path: string, maxDeliveriesPerRun = 100) {
    this.maxDeliveriesPerRun = maxDeliveriesPerRun;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists runs (
        id text primary key,
        nonce text,
        secret text,
        secret_at text,
        created_at text not null
      );
      create table if not exists deliveries (
        run_id text not null references runs(id),
        svix_id text not null,
        svix_timestamp text,
        svix_signature text,
        body blob not null,
        received_at text not null,
        repeats integer not null default 0,
        primary key (run_id, svix_id)
      );
    `);
  }

  createRun(id: string, nonce: string | null, now: Date): void {
    this.db.prepare("insert into runs (id, nonce, created_at) values (?, ?, ?)").run(id, nonce, now.toISOString());
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("select * from runs where id = ?").get(id) as Row | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      nonce: row.nonce as string | null,
      secret: row.secret as string | null,
      secretAt: row.secret_at as string | null,
      createdAt: row.created_at as string,
    };
  }

  /** The latest secret wins: an agent that sent the wrong one first can correct it. */
  setSecret(id: string, secret: string, now: Date): boolean {
    const result = this.db.prepare("update runs set secret = ?, secret_at = ? where id = ?").run(secret, now.toISOString(), id);
    return Number(result.changes) > 0;
  }

  /**
   * Stores a delivery once. The same delivery id again only bumps `repeats`,
   * because Svix retries and a retry must not look like a second email.
   */
  addDelivery(runId: string, delivery: Omit<Delivery, "repeats">): AddDeliveryResult {
    const existing = this.db.prepare("select 1 from deliveries where run_id = ? and svix_id = ?").get(runId, delivery.svixId);
    if (existing) {
      this.db.prepare("update deliveries set repeats = repeats + 1 where run_id = ? and svix_id = ?").run(runId, delivery.svixId);
      return "duplicate";
    }
    const count = this.db.prepare("select count(*) as n from deliveries where run_id = ?").get(runId) as Row;
    if (Number(count.n) >= this.maxDeliveriesPerRun) {
      return "full";
    }
    this.db
      .prepare(
        "insert into deliveries (run_id, svix_id, svix_timestamp, svix_signature, body, received_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(runId, delivery.svixId, delivery.timestamp, delivery.signature, delivery.body, delivery.receivedAt);
    return "stored";
  }

  deliveries(runId: string): Delivery[] {
    const rows = this.db.prepare("select * from deliveries where run_id = ? order by received_at, svix_id").all(runId) as Row[];
    return rows.map((row) => ({
      svixId: row.svix_id as string,
      timestamp: row.svix_timestamp as string | null,
      signature: row.svix_signature as string | null,
      body: row.body as Uint8Array,
      receivedAt: row.received_at as string,
      repeats: Number(row.repeats),
    }));
  }

  close(): void {
    this.db.close();
  }
}
