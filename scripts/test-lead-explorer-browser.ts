// Component-level browser checks against the real Explorer route/components.
// Auth, router and query hooks are synthetic fixtures: this is NOT a live login test.
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const out = process.env.TEMP
  ? join(process.env.TEMP, "opencode", "lead-explorer-browser")
  : join(root, ".output", "lead-explorer-browser");
const fixtures: Record<string, string> = {
  entry: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Route} from '${join(root, "src/routes/app.lead-explorer.tsx").replaceAll("\\", "/")}';
    createRoot(document.getElementById('root')).render(React.createElement(Route.options.component));
  `,
  router: `
    import React, {useSyncExternalStore} from 'react';
    let state={group:'area',path:[],owner:'all',important:false,due:false};
    const listeners=new Set();
    export const createFileRoute=()=>options=>({options,useSearch:()=>useSyncExternalStore(
      fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state
    ),useNavigate:()=>({search})=>{
      state=typeof search==='function'?search(state):search;
      history.replaceState(null,'','/?group='+state.group+(state.leadId?'&leadId='+state.leadId:''));
      listeners.forEach(fn=>fn());
    }});
    export function Link({to,search,children,...props}) {
      return <a {...props} href={to+'?leadId='+search.leadId} onClick={e=>{e.preventDefault();window.pipelineLead=search.leadId}}>{children}</a>
    }
  `,
  auth: `
    import {useSyncExternalStore} from 'react';
    export function useAuth(){useSyncExternalStore(fn=>{window.addEventListener('fixture-update',fn);return()=>window.removeEventListener('fixture-update',fn)},()=>window.fixtureRole||'admin');
      return {primaryRole:window.fixtureRole||'admin',user:{id:'00000000-0000-0000-0000-000000000001'}}}
  `,
  queries: `
    import {useState,useSyncExternalStore} from 'react';
    import {branchKey,serviceCategoryKey} from '${join(root, "src/lib/lead-explorer.ts").replaceAll("\\", "/")}';
    const seed=Array.from({length:60},(_,i)=>({
      id:'10000000-0000-0000-0000-'+String(i).padStart(12,'0'),
      customer_name:i===0?'VeryLongCustomerName'.repeat(12):'Fixture customer '+i,
      customer_number:'+1 (555) 123-4567',customer_number_2:null,
      service:[null,'General Plumbing Repair','Historic custom service'][i%3],
      state_code:i%2?'TX':null, main_area:i%3?'Main area':null,sub_area:null,
      cs_status:i%2?'new':'converted',created_at:'2026-11-14T10:00:00Z',
      followup_at:null,is_important:false,context:"Fixture O'Brien_%\\\\",post_text:null,cs_notes:[],
    }));
    function useMode(){return useSyncExternalStore(fn=>{window.addEventListener('fixture-update',fn);return()=>window.removeEventListener('fixture-update',fn)},()=>window.fixtureMode||'ready')}
    function filtered(group,path,filters){
      return seed.filter(row=>{
        const keys=group==='area'?[branchKey(row.state_code),branchKey(row.main_area),branchKey(row.sub_area)]:[serviceCategoryKey(row.service),branchKey(row.service)];
        return path.every((key,i)=>keys[i]===key) && (!filters.query||JSON.stringify(row).toLowerCase().includes(filters.query.toLowerCase()));
      });
    }
    export function useExplorerQuery(action,group,path,filters,enabled=true,leadId=null){
      const mode=useMode();const [,bump]=useState(0);
      const rows=filtered(group,path,filters);
      let value;
      if(action==='summary')value={total:rows.length,new_count:rows.filter(r=>r.cs_status==='new').length,followup_due:0};
      if(action==='detail')value=seed.find(r=>r.id===leadId)||null;
      if(action==='nodes'){
        const counts=new Map();
        for(const row of rows){
          const key=group==='area'?branchKey(row[['state_code','main_area','sub_area'][path.length]]):path.length?branchKey(row.service):serviceCategoryKey(row.service);
          const node=counts.get(key)||{key,total:0,new_count:0};node.total++;if(row.cs_status==='new')node.new_count++;counts.set(key,node);
        }
        value=[...counts.values()];
      }
      return {data:enabled?{action,value}:undefined,isPending:mode==='loading',isSuccess:mode==='ready',isError:mode==='error',error:new Error('Fixture RPC failure'),refetch:()=>{window.fixtureMode='ready';window.dispatchEvent(new Event('fixture-update'));bump(n=>n+1)}};
    }
    export function useExplorerResults(group,path,filters){
      const mode=useMode();const [limit,setLimit]=useState(50);const rows=filtered(group,path,filters);
      return {data:{pages:[{rows:rows.slice(0,limit)}]},isPending:mode==='loading',isError:mode==='error',isFetching:false,isFetchingNextPage:false,error:new Error('Fixture RPC failure'),refetch:()=>{window.fixtureMode='ready';window.dispatchEvent(new Event('fixture-update'))},hasNextPage:limit<rows.length,fetchNextPage:()=>setLimit(n=>n+50)};
    }
  `,
};
const built = await Bun.build({
  entrypoints: ["entry"],
  target: "browser",
  plugins: [
    {
      name: "explorer-browser-fixtures",
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^(entry|@tanstack\/react-router|@\/hooks\/use-auth|@\/hooks\/use-lead-explorer)$/,
          },
          ({ path }) => ({
            path: (
              {
                entry: "entry",
                "@tanstack/react-router": "router",
                "@/hooks/use-auth": "auth",
                "@/hooks/use-lead-explorer": "queries",
              } as Record<string, string>
            )[path],
            namespace: "fixtures",
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: "fixtures" }, ({ path }) => ({
          contents: fixtures[path],
          loader: "tsx",
          resolveDir: root,
        }));
      },
    },
  ],
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
const javascript = await built.outputs[0].text();
const assetDir = join(root, ".output", "public", "assets");
const css = readdirSync(assetDir)
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(join(assetDir, file), "utf8"))
  .join("\n");
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js")
      return new Response(javascript, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/fixture.css")
      return new Response(css, { headers: { "Content-Type": "text/css" } });
    return new Response(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
const browser = await chromium.launch();
try {
  for (const width of [320, 768, 1280]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://localhost:${server.port}`);
      await page.evaluate((value) => {
        document.documentElement.className = value;
      }, theme);
      await page.getByRole("heading", { name: "Lead Explorer", exact: true }).waitFor();
      await page
        .getByRole("button", { name: /^View / })
        .first()
        .waitFor();
      if (width === 320)
        await page.getByRole("region", { name: "Browse next hierarchy level" }).waitFor();
      else {
        const tree = page.getByRole("tree");
        const first = tree.getByRole("treeitem").first();
        await first.focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() =>
          document.querySelector('[role="treeitem"][aria-expanded="true"]'),
        );
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Home");
        await page.keyboard.press("End");
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "All qualified leads", exact: true }).click();
        await page.evaluate(() => {
          window.dispatchEvent(new Event("fixture-update"));
        });
        if (!(await tree.locator('[aria-expanded="true"]').count()))
          throw new Error("Expanded branch collapsed on refresh");
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) throw new Error(`Horizontal overflow: ${width}/${theme}`);
      await page.screenshot({ path: join(out, `${width}-${theme}.png`), fullPage: false });
      const opener = page.getByRole("button", { name: /^View / }).first();
      await opener.click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("link", { name: "Open in CS Pipeline" }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (!(await opener.evaluate((element) => element === document.activeElement))) {
        throw new Error("Drawer did not restore focus to its opener");
      }
      await page.getByRole("button", { name: "Service", exact: true }).click();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await page.getByRole("searchbox").fill("O'Brien_%\\");
      await page.waitForTimeout(400);
      if ((await page.url()).includes("O%27") || (await page.url()).includes("query"))
        throw new Error("Search text leaked to URL");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await page.evaluate(() => {
        Object.assign(window, { fixtureMode: "error" });
        window.dispatchEvent(new Event("fixture-update"));
      });
      await page.getByRole("alert").first().waitFor();
      await page.getByRole("button", { name: "Retry results" }).click();
      await page
        .getByRole("button", { name: /^View / })
        .first()
        .waitFor();
      for (const role of ["scraping", "maturing", "sub_admin", "facebook", "seo"]) {
        await page.evaluate((role) => {
          Object.assign(window, { fixtureRole: role });
          window.dispatchEvent(new Event("fixture-update"));
        }, role);
        await page.getByText("You don't have access to this page.").waitFor();
        if (await page.getByRole("tree").count()) throw new Error("Blocked role rendered explorer");
      }
      if (errors.length) throw new Error(errors.join("\n"));
      console.log(
        `PASS: ${width}px ${theme}; no overflow; drawer; search privacy; retry; role gate${width >= 768 ? "; keyboard tree; expansion retained" : "; mobile drill-down"}`,
      );
      await page.close();
    }
  }
  console.log(`Synthetic component screenshots: ${out}`);
} finally {
  await browser.close();
  server.stop();
}
