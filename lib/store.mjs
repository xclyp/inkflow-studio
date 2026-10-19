import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const kinds = new Set(['work','folder','character','world','outline','prompt','skill','agent','workflow','knowledge','idea','analysis','source','rating']);
export function fail(message, status=400) { throw Object.assign(new Error(message), {status}); }
export function bounded(value, max=2000, required=false) {
  if (typeof value !== 'string' || value.length>max || (required && !value.trim())) fail(`文本为空或超过 ${max} 字符`);
  return value;
}
export function validateData(kind,data) {
  if(!data||typeof data!=='object'||Array.isArray(data)||JSON.stringify(data).length>120000)fail('资料格式不正确或过大');
  for(const name of ['content','summary','genre','category','url','workId','folderId','model','status','type'])if(data[name]!==undefined)bounded(data[name],name==='content'?100000:name==='summary'?5000:2000);
  for(const name of ['tags','skills','steps'])if(data[name]!==undefined){if(!Array.isArray(data[name])||data[name].length>(name==='steps'?6:20))fail(name+' 必须是有长度限制的列表');for(const v of data[name])bounded(v,name==='steps'?24000:150,true);}
  if(kind==='work'){
    if(!['novel','short','script'].includes(data.type))fail('作品类型不正确');
    if(data.target!==undefined&&(!Number.isFinite(data.target)||data.target<1||data.target>100000000))fail('目标字符数不正确');
    if(data.color!==undefined&&(!Number.isInteger(data.color)||data.color<0||data.color>3))fail('封面配色不正确');
  }
  if(kind==='rating'&&(!Number.isFinite(data.score)||data.score<0||data.score>10))fail('评分范围为 0–10');
  if(kind==='workflow'&&(!Array.isArray(data.steps)||!data.steps.length))fail('工作流需要 1–6 步');
  return data;
}
export class Store {
  constructor(path) {
    if(path!==':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chapters(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES objects(id),title TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,title TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chapters_work ON chapters(work_id,position);
      CREATE INDEX IF NOT EXISTS versions_chapter ON versions(chapter_id,created);
    `);
    this.db.prepare("UPDATE jobs SET state='interrupted' WHERE state IN ('queued','running')").run();
  }
  tx(fn) { if(this.inTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.inTransaction=false;} }
  decode(row) { return row ? {...row,data:JSON.parse(row.data)} : null; }
  list(trash=false) { return this.db.prepare('SELECT * FROM objects WHERE deleted=? ORDER BY updated DESC').all(trash?1:0).map(r=>this.decode(r)); }
  object(id,kind) { const row=this.decode(this.db.prepare('SELECT * FROM objects WHERE id=? AND deleted=0').get(id));if(!row || (kind && row.kind!==kind)) fail('记录不存在',404); return row; }
  put(input,id=null) {
    if(!kinds.has(input.kind)) fail('未知资料类型');
    const title=bounded(input.title,180,true); const data=input.data;
    validateData(input.kind,data);
    const now=new Date().toISOString();
    if(id) {
      const old=this.object(id); if(old.kind!==input.kind) fail('不能更改资料类型');
      if(!Number.isInteger(input.revision)) fail('缺少版本号');
      const r=this.db.prepare('UPDATE objects SET title=?,data=?,revision=revision+1,updated=? WHERE id=? AND revision=? AND deleted=0').run(title,JSON.stringify(data),now,id,input.revision);
      if(!r.changes) fail('资料已被其他窗口修改，请刷新后重试',409);
    } else {id=randomUUID();this.db.prepare('INSERT INTO objects(id,kind,title,data,updated) VALUES(?,?,?,?,?)').run(id,input.kind,title,JSON.stringify(data),now);}
    return this.object(id);
  }
  trash(id,restore=false) {
    const row=this.db.prepare('SELECT * FROM objects WHERE id=?').get(id);if(!row) fail('记录不存在',404);
    this.db.prepare('UPDATE objects SET deleted=?,revision=revision+1,updated=? WHERE id=?').run(restore?0:1,new Date().toISOString(),id);
  }
  chapters(work) {this.object(work,'work');return this.db.prepare('SELECT id,work_id,title,position,revision,updated,length(content) AS words FROM chapters WHERE work_id=? ORDER BY position').all(work);}
  chapter(id) {const r=this.db.prepare('SELECT * FROM chapters WHERE id=?').get(id);if(!r)fail('章节不存在',404);this.object(r.work_id,'work');return r;}
  createChapter(input) {
    this.object(input.work_id,'work');const id=randomUUID();const now=new Date().toISOString();
    this.db.prepare('INSERT INTO chapters(id,work_id,title,content,position,updated) VALUES(?,?,?,?,?,?)').run(id,input.work_id,bounded(input.title,180,true),bounded(input.content??'',250000),Number(this.db.prepare('SELECT coalesce(max(position),0)+1 AS n FROM chapters WHERE work_id=?').get(input.work_id).n),now);
    return this.chapter(id);
  }
  save(id,input) {
    bounded(input.content,250000);bounded(input.title,180,true);
    return this.tx(()=>{
      const old=this.chapter(id);if(old.revision!==input.revision)fail('章节存在新版本，请先备份编辑框内容，再重新载入。',409);
      this.db.prepare('INSERT INTO versions(id,chapter_id,title,content,revision,created) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,old.title,old.content,old.revision,new Date().toISOString());
      this.db.prepare('UPDATE chapters SET title=?,content=?,revision=revision+1,updated=? WHERE id=?').run(input.title,input.content,new Date().toISOString(),id);
      this.db.prepare('DELETE FROM versions WHERE chapter_id=? AND id NOT IN (SELECT id FROM versions WHERE chapter_id=? ORDER BY revision DESC LIMIT 80)').run(id,id);
      return this.chapter(id);
    });
  }
  versions(id) { this.chapter(id);return this.db.prepare('SELECT * FROM versions WHERE chapter_id=? ORDER BY revision DESC').all(id); }
  config() {return JSON.parse(this.db.prepare('SELECT data FROM settings WHERE id=1').get()?.data??'{"baseUrl":"https://api.openai.com/v1","model":"","temperature":0.8,"maxTokens":3000}');}
  setConfig(data) {this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(data));}
  job(id) {const r=this.decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));if(!r)fail('任务不存在',404);return r;}
  jobs() {return this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 150').all().map(r=>this.decode(r));}
  newJob(data) {const id=randomUUID(), now=new Date().toISOString();this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(id,'queued',JSON.stringify(data),now,now);return this.job(id);}
  updateJob(id,state,data) {this.db.prepare('UPDATE jobs SET state=?,data=?,updated=? WHERE id=?').run(state,JSON.stringify(data),new Date().toISOString(),id);return this.job(id);}
  backup() {return {format:'inkflow-backup',version:1,created:new Date().toISOString(),objects:this.db.prepare('SELECT * FROM objects').all(),chapters:this.db.prepare('SELECT * FROM chapters').all(),versions:this.db.prepare('SELECT * FROM versions').all()};}
  restore(snapshot) {
    if(snapshot?.format!=='inkflow-backup'||snapshot.version!==1||!Array.isArray(snapshot.objects)||!Array.isArray(snapshot.chapters)||!Array.isArray(snapshot.versions))fail('备份格式不正确');
    if(snapshot.objects.length>15000||snapshot.chapters.length>30000||snapshot.versions.length>100000) fail('备份记录过多');
    return this.tx(()=>{
      // Validate references before removing existing data; rollback preserves originals on any failure.
      const ids=new Set(snapshot.objects.map(r=>r.id));
      for(const r of snapshot.objects){if(!kinds.has(r.kind))fail('备份包含未知类型');bounded(r.id,100,true);bounded(r.title,180,true);bounded(r.updated,60,true);if(!Number.isInteger(r.revision)||r.revision<1||![0,1].includes(r.deleted))fail('备份版本字段无效');validateData(r.kind,JSON.parse(r.data));}
      for(const r of snapshot.chapters){if(!ids.has(r.work_id)||!snapshot.objects.some(o=>o.id===r.work_id&&o.kind==='work'))fail('章节作品引用无效');bounded(r.content,250000);bounded(r.id,100,true);bounded(r.title,180,true);bounded(r.updated,60,true);if(!Number.isInteger(r.revision)||r.revision<1||!Number.isInteger(r.position))fail('章节版本或顺序无效');}
      for(const r of snapshot.versions){bounded(r.id,100,true);bounded(r.title,180,true);bounded(r.content,250000);bounded(r.created,60,true);if(!Number.isInteger(r.revision)||r.revision<1)fail('历史版本字段无效');}
      this.db.exec('DELETE FROM versions; DELETE FROM chapters; DELETE FROM objects;');
      for(const r of snapshot.objects)this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?)').run(r.id,r.kind,r.title,r.data,r.revision,r.deleted,r.updated);
      for(const r of snapshot.chapters)this.db.prepare('INSERT INTO chapters VALUES(?,?,?,?,?,?,?)').run(r.id,r.work_id,r.title,r.content,r.position,r.revision,r.updated);
      for(const r of snapshot.versions)this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?)').run(r.id,r.chapter_id,r.title,r.content,r.revision,r.created);
      this.db.prepare("UPDATE jobs SET state='interrupted' WHERE state='completed'").run();
    });
  }
}
