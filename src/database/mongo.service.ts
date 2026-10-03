import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Collection, Db, Document, IndexDescription, MongoClient } from 'mongodb';

/**
 * Shared MongoDB connection for every feature module. Connects lazily, so the
 * app (and features that do not need a database) boots without MONGODB_URI.
 */
@Injectable()
export class MongoService implements OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client?: MongoClient;
  private dbPromise?: Promise<Db>;
  private readonly indexes = new Map<string, Promise<unknown>>();

  get enabled(): boolean {
    return Boolean(process.env.MONGODB_URI);
  }

  db(): Promise<Db> {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new ServiceUnavailableException(
        'Database disabled: set the MONGODB_URI env variable.',
      );
    }
    this.dbPromise ??= this.connect(uri);
    return this.dbPromise;
  }

  /**
   * The collection, with its indexes created once per process. Index
   * definitions are idempotent, so every instance can run them at startup.
   */
  async collection<T extends Document>(
    name: string,
    indexes: IndexDescription[] = [],
  ): Promise<Collection<T>> {
    const db = await this.db();
    const coll = db.collection<T>(name);
    if (indexes.length > 0) {
      if (!this.indexes.has(name)) {
        const creating = coll.createIndexes(indexes);
        // Retry on the next call instead of failing the collection forever.
        creating.catch(() => this.indexes.delete(name));
        this.indexes.set(name, creating);
      }
      await this.indexes.get(name);
    }
    return coll;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  private async connect(uri: string): Promise<Db> {
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5_000,
      appName: 'universal-backend',
    });
    try {
      await this.client.connect();
    } catch (err) {
      this.dbPromise = undefined;
      this.logger.error(`MongoDB connection failed: ${String(err)}`);
      throw new ServiceUnavailableException('Database unavailable.');
    }
    // Not taken from the URI: Coolify's connection strings name no database
    // (the driver would fall back to "test").
    return this.client.db(process.env.MONGODB_DB || 'universal');
  }
}
