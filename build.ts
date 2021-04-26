import { createHash } from "https://deno.land/std@0.95.0/hash/mod.ts";
import { parse } from "https://deno.land/std@0.95.0/flags/mod.ts";
import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

type Cast = { id: string, name: string, url: string };
type Casts = Map<string, Cast>;
type Serie = { id: string, name: string, cast: string[] };
type Series = Map<string, Serie>;

const args = parse(Deno.args, {
  boolean: ['cache'],
  string: ['output', 'title', 'list'],
  default: { output: 'index.html', title: 'Viki Cast Graph' },
});

if (!args.list) {
  console.error('The --list argument is required');
  Deno.exit(1);
}

const sha256 = (d: string): string => createHash('sha256').update(d).toString();

async function fetchCache(url: string|URL, filename?: string): Promise<Response> {
  if (!args.cache) {
    return fetch(url);
  }

  const hash = filename ?? `cache/${sha256(url.toString())}`;
  try {
    return new Response(await Deno.readTextFile(hash));
  } catch(e) {
    const d = await fetch(url).then(r => r.arrayBuffer());
    await Deno.mkdir('cache').catch(() => true);
    await Deno.writeFile(hash, new Uint8Array(d));
    return new Response(d);
  }
}

async function getList(id: string, page = 1, data = []): Promise<any[]> {
  const url = new URL(`lists/${id}.json`, 'https://api.viki.io/v4/');
  url.searchParams.set('app', '100000a');
  url.searchParams.set('per_page', '50');

  const d = await fetchCache(url).then(r => r.json());
  data = data.concat(d.response);

  if (d.more) {
    return getList(id, page + 1, data);
  }

  return data;
}

async function getCast(url: string): Promise<Cast[]> {
  const p = await fetchCache(url).then(r => r.text());
  const d = new DOMParser().parseFromString(p, 'text/html');
  const data = JSON.parse(d?.querySelector('#__NEXT_DATA__')?.textContent ?? '{}');
  const cast = data.props.pageProps.castsJson as {[key: string]: any}[];

  return cast.map(v => ({
    id: v.person.id,
    name: v.person.name,
    url: v.person.images.poster.url
  }));
}

class Graph {
  private cast: Casts = new Map();
  private series: Series = new Map();
  public edges: { from: string, to: string, label?: string, length?: number }[] = [];
  public nodes: { id: string, label: string, shape: string, image?: string }[] = [];

  private id: string;
  constructor(id: string) {
    this.id = id;
  }

  public async fetch() {
    const list = await getList(this.id);
    const promises = list.map(async l => {
      const c = await getCast(l.url.web);
      c.forEach(v => this.cast.set(v.id, v));

      this.series.set(l.id, {
        id: l.id,
        name: l.titles.en,
        cast: c.map(v => v.id),
      });
    });

    await Promise.all(promises);

    this.cast.forEach(c => {
      if ([...this.series.values()].filter(s => s.cast.includes(c.id)).length <= 1) {
        this.cast.delete(c.id);
      }
    });

    this.series.forEach(s => {
      s.cast = s.cast.filter(c => this.cast.has(c));
    });
  }

  public processCast() {
    this.cast.forEach(cast => {
      this.nodes.push({
        id: cast.id,
        label: cast.name,
        shape: 'circularImage',
        image: cast.url,
      });
    });
  }

  public processSeries() {
    this.series.forEach(serie => {      
      if (serie.cast.length === 2) {
        this.processSeriesSingleEdge(serie);
      } else if (serie.cast.length !== 0) {
        this.processSeriesMutipleEdges(serie);
      }
    });
  }

  private processSeriesMutipleEdges(serie: Serie) {
    this.nodes.push({
      id: serie.id,
      label: serie.name,
      shape: 'text',
    });

    serie.cast.forEach(id => {
      this.edges.push({
        from: serie.id,
        to: id,
      });
    });
  }

  private processSeriesSingleEdge(serie: Serie) {
    this.edges.push({
      from: (this.cast.get(serie.cast[0]) as Cast).id,
      to: (this.cast.get(serie.cast[1]) as Cast).id,
      label: serie.name,
    });
  }
}

const graph = new Graph(args.list);
await graph.fetch();
graph.processCast();
graph.processSeries();

await Deno.writeTextFile(args.output, `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>${args.title}</title>
    <style type="text/css">
      html, body {
        margin: 0;
        width: 100vw;
        height: 100vh;
      }
      #network {
        width: 100vw;
        height: 100vh;
      }
    </style>
  </head>
  <body>
    <div id="network"></div>

    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <script type="module">
      const nodes = new vis.DataSet(${JSON.stringify(graph.nodes)});
      const edges = new vis.DataSet(${JSON.stringify(graph.edges)});
      const container = document.getElementById('network');
      new vis.Network(container, { nodes, edges }, {});
    </script>
  </body>
</html>
`);
