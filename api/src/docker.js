import Docker from "dockerode";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost";
const WORKDIR = "/workdir";

const containerName = (id) => `fn-${id}`;
const imageName = (id) => `fpm-fn-${id}:latest`;

const RUNNER = `import http from "node:http";
import handler from "./handler.mjs";

const server = http.createServer(async (req, res) => {
  try {
    const url = "http://localhost" + req.url;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
      else if (v != null) headers.set(k, String(v));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const fetchReq = new Request(url, { method: req.method, headers, body });
    const out = await handler(fetchReq);
    res.statusCode = out.status;
    out.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await out.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end("Function error: " + (e?.message || e));
  }
});
server.listen(8080, () => console.log("[fn] listening on :8080"));
`;

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY handler.mjs ./handler.mjs
COPY server.mjs ./server.mjs
EXPOSE 8080
CMD ["node","server.mjs"]
`;

async function buildImage(fn) {
  const dir = join(WORKDIR, fn.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "handler.mjs"), fn.code);
  await writeFile(join(dir, "server.mjs"), RUNNER);
  await writeFile(join(dir, "Dockerfile"), DOCKERFILE);

  await new Promise((resolve, reject) => {
    const p = spawn("docker", ["build", "-t", imageName(fn.id), "."], { cwd: dir });
    p.stdout.on("data", d => process.stdout.write(d));
    p.stderr.on("data", d => process.stderr.write(d));
    p.on("exit", c => c === 0 ? resolve() : reject(new Error("docker build failed")));
  });
}

export async function stopAndRemove(id) {
  try {
    const c = docker.getContainer(containerName(id));
    await c.remove({ force: true });
  } catch {}
}

export async function buildAndDeploy(fn, secrets) {
  await buildImage(fn);
  await stopAndRemove(fn.id);

  const env = secrets.map(s => `${s.key}=${s.value}`);
  const container = await docker.createContainer({
    name: containerName(fn.id),
    Image: imageName(fn.id),
    Env: env,
    ExposedPorts: { "8080/tcp": {} },
    Labels: { "fpm.function.id": fn.id },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] },
    },
  });

  await container.start();
  const info = await container.inspect();
  const hostPort = info.NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostPort;
  if (!hostPort) throw new Error("Docker did not assign a public port to the function container");

  const url = `http://${PUBLIC_HOST}:${hostPort}`;
  return { containerId: container.id, url };
}

export async function streamLogs(id, onLine) {
  const c = docker.getContainer(containerName(id));
  const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 200, timestamps: true });
  let buf = "";
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const l of lines) {
      const clean = l.replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim();
      if (clean) onLine(clean);
    }
  };
  stream.on("data", onData);
  stream.on("error", () => {});
  return () => { try { stream.destroy(); } catch {} };
}
