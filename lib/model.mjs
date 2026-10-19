import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { bounded, fail } from './store.mjs';

export function validateConfig(input, hosts) {
  let url;try{url=new URL(input.baseUrl);}catch{fail('模型地址必须是完整 HTTPS URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||isIP(url.hostname)||!hosts.includes(url.hostname.toLowerCase()))fail('模型域名未列入 .env 的 WRITING_ALLOWED_HOSTS，或地址包含不允许的字段');
  const model=bounded(input.model,120,true);
  const temperature=Number(input.temperature),maxTokens=Number(input.maxTokens);
  if(!Number.isFinite(temperature)||temperature<0||temperature>2||!Number.isInteger(maxTokens)||maxTokens<128||maxTokens>16000)fail('温度范围 0–2，输出上限 128–16000');
  return {baseUrl:url.href.replace(/\/$/,''),model,temperature,maxTokens};
}
export function publicAddress(ip) {
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
  if(isIP(ip)===6) return /^2[0-9a-f]{3}:/i.test(ip)&&!ip.toLowerCase().startsWith('2001:db8:');
  return false;
}
export async function complete(config,messages,{key,signal,fetcher=fetch,resolve=lookup}={}) {
  if(!key)fail('尚未配置模型密钥。请在本地 .env 填写 WRITING_API_KEY 并重启服务。');
  const host=new URL(config.baseUrl).hostname;
  const ips=await resolve(host,{all:true});if(!ips.length||ips.some(r=>!publicAddress(r.address)))fail('模型域名解析到非公网地址，已拒绝连接');
  const response=await fetcher(config.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(120000)]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:config.model,messages,temperature:config.temperature,max_tokens:config.maxTokens,stream:false})});
  if(!response.ok)fail(`模型服务返回 HTTP ${response.status}，请检查模型名称、额度和密钥。`,502);
  const reader=response.body.getReader();let chunks=[],size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000)fail('模型返回内容过大',502);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('模型返回的不是有效 JSON',502);}
  const text=json.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())fail('模型未返回正文',502);
  return {text:bounded(text,250000),usage:json.usage??null,model:json.model??config.model};
}
