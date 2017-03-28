import * as mongo from 'mongodb';
import Config from '../config';
import {
  Named, Base, IndexConfig,
  BulkState, BulkResponse, QueryOptions
} from '../model';
import { ObjectUtil } from '@encore/util';

const flat = require('flat');

interface Cls<T> extends Named {
  new (...args:any[]): T;
}

export class MongoService {

  private static clientPromise: Promise<mongo.Db>;
  private static indices: { [key: string]: IndexConfig[] } = {};

  static isActive() { return !!MongoService.clientPromise; }

  static translateQueryIds(query: Object & { _id?: any }) {
    if (query._id) {
      if (typeof query._id === 'string') {
        query._id = new mongo.ObjectID(query._id);
      } else if (ObjectUtil.isPlainObject(query._id)) {
        if (query._id['$in']) {
          query._id['$in'] = query._id['$in'].map((x: any) => typeof x === 'string' ? new mongo.ObjectID(x) : x);
        }
      }
    }
    return query;
  }

  static getUrl(schema: string = Config.schema, options: any = Config.options) {
    let hosts = Config.hosts.split(',').map(h => `${h}:${Config.port}`).join(',');
    let opts = Object.keys(options).map(k => `${k}=${options[k]}`).join('&');
    return `mongodb://${hosts}/${schema}?${opts}`;
  }

  static getSchema() {
    return Config.schema;
  }

  static getClient(): Promise<mongo.Db> {
    if (!MongoService.clientPromise) {
      MongoService.clientPromise =
        mongo.MongoClient.connect(MongoService.getUrl())
          .then(client =>
            MongoService.establishIndices(client)
              .then(() => client));
    }
    return MongoService.clientPromise;
  }

  static getCollectionName(named: Named): string {
    return named.collection || named.name;
  }

  static async getCollection(named: Named): Promise<mongo.Collection> {
    let db = await MongoService.getClient();
    return db.collection(MongoService.getCollectionName(named));
  }

  static async resetDatabase() {
    let client = await MongoService.getClient();
    await client.dropDatabase();
    delete MongoService.clientPromise;
  }

  static registerIndex(named: Named, fields: { [key: string]: number }, config: mongo.IndexOptions) {
    let col = MongoService.getCollectionName(named);
    MongoService.indices[col] = MongoService.indices[col] || [];
    MongoService.indices[col].push([fields, config]);
  }

  static async establishIndices(client: mongo.Db) {
    let promises = [];

    for (let colName of Object.keys(MongoService.indices)) {
      let col = await client.collection(colName);

      for (let [fields, config] of MongoService.indices[colName]) {
        promises.push(col.createIndex(fields, config));
      }
    }

    return Promise.all(promises);
  }

  static getIndices(named: Named) {
    return MongoService.indices[MongoService.getCollectionName(named)];
  }

  static async getIdsByQuery(named: Named, query: Object) {
    let col = await MongoService.getCollection(named);
    let objs = await col.find(query, { _id: true }).toArray();
    return objs.map(x => x._id.toHexString());
  }

  static async getByQuery<T extends Base>(named: Named | Cls<T>, query: Object & { _id?: any } = {}, options: QueryOptions = {}): Promise<T[]> {
    query = MongoService.translateQueryIds(query);

    let col = await MongoService.getCollection(named);
    let cursor = col.find(query);
    if (options.sort) {
      cursor = cursor.sort(options.sort);
    }

    cursor = cursor.limit(Math.trunc(options.limit || 200) || 200);

    if (options.offset) {
      cursor = cursor.skip(Math.trunc(options.offset) || 0);
    }
    let res = await cursor.toArray();
    res.forEach((r: any) => r._id = (r._id as any).toHexString());
    return res;
  }

  static async getCountByQuery(named: Named, query: Object & { _id?: any } = {}, options: QueryOptions = {}): Promise<{ count: number }> {
    query = MongoService.translateQueryIds(query);

    let col = await MongoService.getCollection(named);
    let cursor = col.count(query);

    let res = await cursor;
    return { count: res };
  }

  static async findOne<T extends Base>(named: Named | Cls<T>, query: Object, options: QueryOptions = {}, failOnMany = true): Promise<T> {
    let res = await MongoService.getByQuery<T>(named, query, options);
    if (!res || res.length < 1 || (failOnMany && res.length !== 1)) {
      throw new Error(`Invalid number of results for find by id: ${res ? res.length : res}`);
    }
    return res[0] as T;
  }

  static async getById<T extends Base>(named: Named, id: string): Promise<T>;
    static async getById<T extends Base>(named: Named | Cls<T>, id: string): Promise<T> {
    return await MongoService.findOne<T>(named, { _id: new mongo.ObjectID(id) });
  }

  static async deleteById(named: Named, id: string): Promise<number> {
    let col = await MongoService.getCollection(named);
    let res = await col.deleteOne({ _id: new mongo.ObjectID(id) });

    return res.deletedCount || 0;
  }

  static async deleteByQuery(named: Named, query: Object & { _id?: any } = {}): Promise<number> {
    query = MongoService.translateQueryIds(query);
    let col = await MongoService.getCollection(named);
    let res = await col.deleteMany(query);
    return res.deletedCount || 0;
  }

  static async save<T extends Base>(named: Named, o: T, removeId: boolean = true): Promise<T> {
    let col = await MongoService.getCollection(named);
    if (removeId) {
      delete o._id;
    }
    let res = await col.insertOne(o);
    o._id = res.insertedId.toHexString();
    return o;
  }

  static async saveAll<T extends Base>(named: Named, objs: T[]): Promise<T[]> {
    let col = await MongoService.getCollection(named);
    let res = await col.insertMany(objs);
    for (let i = 0; i < objs.length; i++) {
      objs[i]._id = res.insertedIds[i].toHexString();
    }
    return objs;
  }

  static async update<T extends Base>(named: Named, o: T): Promise<T> {
    let col = await MongoService.getCollection(named);
    o._id = (new mongo.ObjectID(o._id) as any);
    await col.replaceOne({ _id: o._id }, o);
    o._id = (o._id as any).toHexString();
    return o;
  }

  static async partialUpdate<T extends Base>(named: Named, id: string, data: any, opts: mongo.FindOneAndReplaceOption = {}): Promise<T> {
    return await MongoService.partialUpdateByQuery<T>(named, { _id: id }, data, opts);
  }

  static async partialUpdateByQuery<T extends Base>(named: Named, query: any, data: any, opts: mongo.FindOneAndReplaceOption = {}): Promise<T> {
    let col = await MongoService.getCollection(named);
    query = MongoService.translateQueryIds(query);

    if (Object.keys(data)[0].charAt(0) !== '$') {
      data = { $set: flat(data) };
    }

    let res = await col.findOneAndUpdate(query, data, Object.assign({ returnOriginal: false }, opts));
    if (!res.value) {
      throw new Error('Object not found for updating');
    }
    let ret: T = res.value as T;
    ret._id = (ret._id as any).toHexString();
    return ret;
  }

  static async updateMany<T extends Base>(named: Named, query: any, data: any, options?: { upsert?: boolean; w?: any; wtimeout?: number; j?: boolean; }) {
    let col = await MongoService.getCollection(named);
    query = MongoService.translateQueryIds(query);

    if (Object.keys(data)[0].charAt(0) !== '$') {
      data = { $set: flat(data) };
    }

    let res = await col.updateMany(query, data, options);
    return res.matchedCount;
  }

  static async bulkProcess<T extends Base>(named: Named, state: BulkState<T>) {
    let col = await MongoService.getCollection(named);
    let bulk = col.initializeUnorderedBulkOp({});
    let count = 0;

    (state.upsert || []).forEach(p => {
      count++;
      let id: any = state.getId(p);
      if (id._id === undefined || id._id !== p._id) {
        delete p._id;
      } else {
        id._id = (p as any)._id = new mongo.ObjectID(p._id);
      }

      bulk.find(id).upsert().updateOne({
        $set: p
      });
    });

    (state.delete || []).forEach(p => {
      count++;
      bulk.find(state.getId(p)).removeOne();
    });

    let out: BulkResponse = {
      count: {
        delete: 0,
        update: 0,
        insert: 0
      }
    };

    if (count > 0) {
      let res = await bulk.execute({});
      let updatedCount = 0;

      if (out.count) {
        out.count.delete = res.nRemoved;
        out.count.update = updatedCount;
        out.count.update -= out.count.insert;
      }

      if (res.hasWriteErrors()) {
        out.error = res.getWriteErrors();
      }
    }

    return out;
  }
}