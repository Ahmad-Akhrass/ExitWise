import { useEffect, useRef } from "react";
import { Check, ChevronDown, Cloud, FileCheck2, KeyRound, LockKeyhole, Mail, RefreshCw, Shield, ShieldCheck, Users, X } from "lucide-react";
import type { StepId } from "@/lib/model";
export const statusLabel:Record<string,string>={draft:"Draft",awaiting_approval:"Plan approval",awaiting_removal_approval:"Removal approval",ready:"Ready to run",in_progress:"In progress",needs_attention:"Needs attention",completed:"Completed"};
export const stepLabel:Record<string,string>={pending:"Pending",running:"Running",completed:"Completed",manual:"Your input needed",approval:"Approval needed",failed:"Needs review",retained:"Retained"};
export const initials=(name:string)=>name.split(/[\s@.]+/).filter(Boolean).slice(0,2).map(s=>s[0]).join("").toUpperCase();
export const date=(v:string)=>new Date(v).toLocaleDateString(undefined,{month:"short",day:"numeric"});
export const time=(v:string)=>new Date(v).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
export const fullDate=(v:string)=>new Date(v).toLocaleString(undefined,{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit"});
export function MsMark(){return <span className="ms-mark" aria-hidden="true"><i/><i/><i/><i/></span>;}
export function Badge({status}:{status:string}){return <span className={"badge status-"+status}><span/>{statusLabel[status]||stepLabel[status]||status}</span>;}
export function Avatar({name,tone=0}:{name:string;tone?:number}){return <span className={"avatar tone-"+(tone%5)}>{initials(name)}</span>;}
export function ServiceIcon({id}:{id:string}) {const icons:Record<string,React.ReactNode>={block:<LockKeyhole/>,revoke:<RefreshCw/>,roles:<KeyRound/>,mailbox:<Mail/>,onedrive:<Cloud/>,groups:<Users/>,licenses:<MsMark/>,review:<ShieldCheck/>,document:<FileCheck2/>};return <span className={"service-icon service-"+id}>{icons[id]||<Shield/>}</span>;}
export function Modal({title,subtitle,children,onClose,wide=false}:{title:string;subtitle?:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}) {
  const ref=useRef<HTMLDivElement>(null);const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const before=document.activeElement as HTMLElement;const old=document.body.style.overflow;document.body.style.overflow="hidden";ref.current?.focus();const handler=(e:KeyboardEvent)=>{if(e.key==="Escape")close.current();if(e.key==="Tab"){const items=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');if(!items?.length)return;const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener("keydown",handler);return()=>{document.removeEventListener("keydown",handler);document.body.style.overflow=old;before?.focus();};},[]);
  return <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} tabIndex={-1} className={"modal "+(wide?"modal-wide":"")} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X/></button></div>{children}</div></div>;
}
