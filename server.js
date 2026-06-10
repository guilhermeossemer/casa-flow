const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 5173);

const tipos = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function responder(res, status, corpo, tipo = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": tipo });
  res.end(corpo);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const caminho = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const arquivo = path.normalize(path.join(root, caminho));

  if (!arquivo.startsWith(root)) {
    responder(res, 403, "Acesso negado");
    return;
  }

  fs.readFile(arquivo, (erro, conteudo) => {
    if (erro) {
      responder(res, 404, "Arquivo nao encontrado");
      return;
    }

    responder(res, 200, conteudo, tipos[path.extname(arquivo)] || "application/octet-stream");
  });
});

server.listen(port, () => {
  console.log(`CasaFlow em http://localhost:${port}`);
});
