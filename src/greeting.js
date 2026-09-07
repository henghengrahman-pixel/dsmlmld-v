import { config } from './config.js';

export function daypart(date=new Date(), timeZone=config.timezone){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const hour=Number(parts.find(p=>p.type==='hour')?.value||0);
  if(hour>=5 && hour<11) return 'pagi';
  if(hour>=11 && hour<15) return 'siang';
  if(hour>=15 && hour<19) return 'sore';
  return 'malam';
}
export function greetingText(date=new Date(), timeZone=config.timezone){
  const part=daypart(date,timeZone);
  return `Selamat ${part}, bosku 😊🙏 Ada yang bisa kami bantu ${part} ini bosku?`;
}
