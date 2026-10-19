import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, bounded, fail } from './lib/store.mjs';
import { seed } from './lib/seed.mjs';
import { validateConfig, complete } from './lib/model.mjs';

const root=dirname(fileURLToPath(import.meta.url));
if(existsSync(resolve(root,'.env'))) for(const line of readFileSync(resolve(root,'.env'),'utf8').split(/\r?\n/)){
  const m=line.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();
}
export function createApp({dbPath=resolve(root,'data/inkflow.sqlite'),modelCall=complete,apiKey=process.env.WRITING_API_KEY}={}) {
  const store=new Store(dbPath);seed(store);
  const token=randomBytes(32).toString('hex');const controllers=new Map();
  const allowedHosts=(process.env.WRITING_ALLOWED_HOSTS??'api.openai.com,api.deepseek.com,openrouter.ai').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  function send(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
  async function body(req,max=1800000) {let n=0,parts=[];for await(const c of req){n+=c.length;if(n>max)fail('请求内容过大',413);parts.push(c);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('请求必须是有效 JSON');}}
  const auth=req=>{const provided=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('inkflow_session='))?.slice(16)??'';return provided.length===token.length&&timingSafeEqual(Buffer.from(provided),Buffer.from(token));};
  async function run(job) {
    const controller=new AbortController();controllers.set(job.id,controller);
    let data={...job.data,outputs:[]};store.updateJob(job.id,'running',data);
    try{
      const config=validateConfig(store.config(),allowedHosts);
      let previous='';
      for(let i=0;i<data.steps.length;i++){
        controller.signal.throwIfAborted();
        const result=await modelCall(config,[{role:'system',content:data.system},{role:'user',content:`创作任务：${data.steps[i]}\n\n作者要求：${data.instruction}\n\n作品上下文：\n${data.context}\n\n${previous?'上一步结果：\n'+previous:''}`}],{key:apiKey,signal:controller.signal});
        controller.signal.throwIfAborted();
        data.outputs.push({step:i+1,...result});previous=result.text;
        store.updateJob(job.id,'running',data);
      }
      store.updateJob(job.id,'completed',{...data,result:previous});
    }catch(e){store.updateJob(job.id,controller.signal.aborted?'cancelled':'failed',{...data,error:controller.signal.aborted?'任务已取消':e.status?e.message:'模型连接失败或超时，请检查地址和服务状态。'});}
    finally{controllers.delete(job.id);}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host??'';
      if(!/^127\.0\.0\.1:\d+$/.test(host)&&!/^localhost:\d+$/.test(host))fail('仅允许本机访问',403);
      const url=new URL(req.url,'http://'+host), path=url.pathname;
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy','no-referrer');
      if(!path.startsWith('/api/')){
        if(req.method!=='GET')fail('不支持此方法',405);
        const files={'/':['dist/index.html','text/html; charset=utf-8'],'/app.js':['dist/app.js','text/javascript; charset=utf-8'],'/style.css':['dist/style.css','text/css; charset=utf-8']};
        if(!files[path])fail('页面不存在',404);
        if(path==='/')res.setHeader('Set-Cookie',`inkflow_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200,{'Content-Type':files[path][1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(readFileSync(resolve(root,files[path][0])));return;
      }
      if(!auth(req))fail('请重新打开首页以建立本地会话',401);
      if(req.method!=='GET'){
        if(req.headers.origin!=='http://'+host)fail('拒绝跨站请求',403);
        if(!req.headers['content-type']?.startsWith('application/json'))fail('请求类型必须为 JSON',415);
      }
      const method=req.method;
      if(path==='/api/state'&&method==='GET')return send(res,{objects:store.list(),jobs:store.jobs(),config:store.config(),keyConfigured:!!apiKey,allowedHosts});
      if(path==='/api/objects'&&method==='POST')return send(res,store.put(await body(req)),201);
      if(path==='/api/trash'&&method==='GET')return send(res,store.list(true));
      const object=path.match(/^\/api\/objects\/([\w-]+)$/);
      if(object&&method==='PUT')return send(res,store.put(await body(req),object[1]));
      if(object&&method==='DELETE'){store.trash(object[1]);return send(res,{ok:true});}
      const restore=path.match(/^\/api\/objects\/([\w-]+)\/restore$/);
      if(restore&&method==='POST'){await body(req);store.trash(restore[1],true);return send(res,{ok:true});}
      if(path==='/api/chapters'&&method==='GET')return send(res,store.chapters(url.searchParams.get('work')));
      if(path==='/api/chapters'&&method==='POST')return send(res,store.createChapter(await body(req)),201);
      const chapter=path.match(/^\/api\/chapters\/([\w-]+)$/);
      if(chapter&&method==='GET')return send(res,store.chapter(chapter[1]));
      if(chapter&&method==='PUT')return send(res,store.save(chapter[1],await body(req)));
      const versions=path.match(/^\/api\/chapters\/([\w-]+)\/versions$/);
      if(versions&&method==='GET')return send(res,store.versions(versions[1]));
      if(path==='/api/config'&&method==='PUT'){store.setConfig(validateConfig(await body(req),allowedHosts));return send(res,{ok:true});}
      if(path==='/api/backup'&&method==='GET')return send(res,store.backup());
      if(path==='/api/backup'&&method==='POST'){
        if(controllers.size)fail('请先取消所有生成任务，再恢复备份',409);
        const data=await body(req,30000000);if(data.confirm!=='恢复备份')fail('缺少恢复确认');store.restore(data.snapshot);return send(res,{ok:true});
      }
      if(path==='/api/import'&&method==='POST'){
        const input=await body(req,6000000);bounded(input.text,2000000,true);bounded(input.title,180,true);
        const result=store.tx(()=>{
          const work=store.put({kind:'work',title:input.title,data:{type:['novel','short','script'].includes(input.type)?input.type:'novel',genre:'导入作品',summary:'从本地文本导入',target:100000,status:'writing',color:2}});
          const segments=input.text.split(/(?=^第[一二三四五六七八九十百千万零〇\d]+[章回节](?:[ \t]+[^\n]*)?\r?$)/m).filter(s=>s.trim());
          if(segments.length>600)fail('单次导入不能超过 600 章');
          for(let i=0;i<segments.length;i++){
            const segment=segments[i].trim(), first=segment.split('\n')[0];
            store.createChapter({work_id:work.id,title:/^第.+[章回节]/.test(first)?first.slice(0,180):`第 ${i+1} 章`,content:segment});
          }return work;
        });return send(res,result,201);
      }
      if(path==='/api/jobs'&&method==='POST'){
        if(controllers.size>=2)fail('同时最多运行两个生成任务，请等待或取消',429);
        if(!apiKey)fail('尚未配置模型密钥，请先打开模型设置，按指引填写本地 .env。');
        validateConfig(store.config(),allowedHosts);
        const input=await body(req);bounded(input.instruction,12000,true);
        let context='',system='你是中文原创写作助手。尊重作者的创作意图，只依据提供的资料，缺失信息明确说明。输出可供作者审核的候选稿。';
        let steps=[input.task??'根据作者要求提供创作建议'];let baseRevision=null;
        if(input.agentId){const agent=store.object(input.agentId,'agent');system=bounded(agent.data.content,18000,true);for(const id of (agent.data.skills??[]).slice(0,8))system+='\n写作技能：'+bounded(store.object(id,'skill').data.content,12000);}
        if(input.promptId)steps=[bounded(store.object(input.promptId,'prompt').data.content,24000,true)];
        if(input.workflowId){steps=store.object(input.workflowId,'workflow').data.steps;if(!Array.isArray(steps)||steps.length<1||steps.length>6)fail('工作流应包含 1–6 步');}
        steps=steps.map(s=>bounded(s,24000,true));
        if(input.workId){const work=store.object(input.workId,'work');context=`作品：${work.title}\n简介：${work.data.summary??''}\n`;const notes=store.list().filter(o=>['character','world','outline'].includes(o.kind)&&o.data.workId===work.id);for(const n of notes)context+=`${n.title}：${n.data.content??''}\n`;}
        if(input.chapterId){const ch=store.chapter(input.chapterId);if(ch.work_id!==input.workId)fail('章节与作品不匹配');context+=`当前章：${ch.title}\n${ch.content}`;baseRevision=ch.revision;}
        for(const id of (Array.isArray(input.knowledgeIds)?input.knowledgeIds:[]).slice(0,8)){const k=store.object(id,'knowledge');context+=`\n参考知识：${k.title}\n${k.data.content??''}`;}
        if(context.length>80000)fail('上下文超过 8 万字符，请减少资料或缩短当前章节。');
        const job=store.newJob({label:bounded(input.label??'AI 创作',180),instruction:input.instruction,steps,system,context,chapterId:input.chapterId??null,workId:input.workId??null,baseRevision,outputs:[]});
        void run(job);return send(res,job,202);
      }
      const job=path.match(/^\/api\/jobs\/([\w-]+)$/);
      if(job&&method==='GET')return send(res,store.job(job[1]));
      const cancel=path.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
      if(cancel&&method==='POST'){await body(req);controllers.get(cancel[1])?.abort();return send(res,{ok:true});}
      const apply=path.match(/^\/api\/jobs\/([\w-]+)\/apply$/);
      if(apply&&method==='POST'){
        const input=await body(req);const j=store.job(apply[1]);if(j.state!=='completed'||j.data.applied)fail('此任务未完成或已应用',409);
        if(!j.data.chapterId)fail('任务没有关联章节，请复制候选稿后使用');
        const ch=store.chapter(j.data.chapterId);if(ch.revision!==j.data.baseRevision)fail('生成期间章节已经修改，请手动比对候选稿，不能自动覆盖。',409);
        if(!['append','replace'].includes(input.mode))fail('请选择追加或替换');
        const saved=store.tx(()=>{const result=store.save(ch.id,{title:ch.title,content:input.mode==='append'?ch.content+'\n\n'+j.data.result:j.data.result,revision:ch.revision});store.updateJob(j.id,j.state,{...j.data,applied:true});return result;});
        return send(res,saved);
      }
      fail('接口不存在',404);
    }catch(e){if(!res.headersSent)send(res,{error:e.status?e.message:'服务处理失败，原有数据已保留。'},e.status??500);else res.end();}
  });
  return {server,store,close(){for(const c of controllers.values())c.abort();server.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();const port=Number(process.env.PORT??5181);
  app.server.listen(port,'127.0.0.1',()=>console.log(`墨舟 AI 已启动：http://127.0.0.1:${port}\n数据目录：${resolve(root,'data')}\n仅本机访问；按 Ctrl+C 停止。`));
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被占用，请修改 .env 中的 PORT。':e.message);process.exitCode=1;});
}
