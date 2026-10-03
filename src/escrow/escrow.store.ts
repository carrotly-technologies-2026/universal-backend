import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EscrowDetails } from './details.js';
import { WaybillMimeType } from './file-type.js';
import { WaybillValidation } from './waybill-validator.service.js';

export interface StoredWaybill {
  hash: string;
  mimeType: WaybillMimeType;
  size: number;
  uploadedAt: string;
  validation: WaybillValidation;
}

interface WaybillRow {
  hash: string;
  mime_type: WaybillMimeType;
  size: number;
  uploaded_at: string;
  validation: string;
}

const toWaybill = (row: WaybillRow): StoredWaybill => ({
  hash: row.hash,
  mimeType: row.mime_type,
  size: row.size,
  uploadedAt: row.uploaded_at,
  validation: JSON.parse(row.validation) as WaybillValidation,
});

/** SQLite metadata plus content-addressed waybill files under DATA_DIR. */
@Injectable()
export class EscrowStore implements OnModuleDestroy {
  private readonly waybillDir: string;
  private readonly db: DatabaseSync;

  constructor() {
    const dataDir = process.env.DATA_DIR ?? './data';
    this.waybillDir = join(dataDir, 'waybills');
    mkdirSync(this.waybillDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'escrow.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS details (
        escrow TEXT PRIMARY KEY,
        item_title TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waybills (
        escrow TEXT NOT NULL,
        hash TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_at TEXT NOT NULL,
        validation TEXT NOT NULL,
        PRIMARY KEY (escrow, hash)
      );
    `);
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  saveDetails(escrow: string, d: EscrowDetails): void {
    this.db
      .prepare(
        `INSERT INTO details VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (escrow) DO UPDATE SET item_title = excluded.item_title,
           recipient_name = excluded.recipient_name,
           recipient_address = excluded.recipient_address,
           updated_at = excluded.updated_at`,
      )
      .run(
        escrow,
        d.itemTitle,
        d.recipientName,
        d.recipientAddress,
        new Date().toISOString(),
      );
  }

  getDetails(escrow: string): EscrowDetails | null {
    const row = this.db
      .prepare(
        'SELECT item_title, recipient_name, recipient_address FROM details WHERE escrow = ?',
      )
      .get(escrow) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      itemTitle: row.item_title,
      recipientName: row.recipient_name,
      recipientAddress: row.recipient_address,
    };
  }

  getWaybill(escrow: string, hash: string): StoredWaybill | null {
    const row = this.db
      .prepare('SELECT * FROM waybills WHERE escrow = ? AND hash = ?')
      .get(escrow, hash) as WaybillRow | undefined;
    return row ? toWaybill(row) : null;
  }

  listWaybills(escrow: string): StoredWaybill[] {
    const rows = this.db
      .prepare('SELECT * FROM waybills WHERE escrow = ? ORDER BY uploaded_at')
      .all(escrow) as unknown as WaybillRow[];
    return rows.map(toWaybill);
  }

  /** Stores the file and its metadata; returns the stored row (first upload wins). */
  saveWaybill(
    escrow: string,
    file: Buffer,
    w: Omit<StoredWaybill, 'uploadedAt'>,
  ): StoredWaybill {
    // Content-addressed, so rewriting an existing file is harmless.
    writeFileSync(this.filePath(w.hash), file);
    this.db
      .prepare('INSERT OR IGNORE INTO waybills VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        escrow,
        w.hash,
        w.mimeType,
        w.size,
        new Date().toISOString(),
        JSON.stringify(w.validation),
      );
    return this.getWaybill(escrow, w.hash)!;
  }

  filePath(hash: string): string {
    return join(this.waybillDir, hash);
  }
}
