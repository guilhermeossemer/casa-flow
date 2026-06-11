const app = document.getElementById("app");
const modalRoot = document.getElementById("modalRoot") || document.createElement("div");
const toastRoot = document.getElementById("toastRoot") || document.createElement("div");

if (!modalRoot.id) {
    modalRoot.id = "modalRoot";
    document.body.appendChild(modalRoot);
}

if (!toastRoot.id) {
    toastRoot.id = "toastRoot";
    document.body.appendChild(toastRoot);
}

let acaoConfirmacao = null;
let timerDesfazer = null;
let snapshotDesfazer = null;
let telaAtual = "home";
let navegandoPeloHistorico = false;
let filtroContagemTexto = "";
let filtroContagemCategoria = "";
let firebaseApp = null;
let auth = null;
let db = null;
let usuarioAtual = null;
let dadosCarregados = false;
let timerSalvarFirebase = null;

// ===== HELPERS =====
const CATEGORIAS_BASE = [
    "Mercado",
    "Hortifruti",
    "Carnes",
    "Frios e laticínios",
    "Padaria",
    "Bebidas",
    "Temperos",
    "Enlatados",
    "Congelados",
    "Limpeza",
    "Lavanderia",
    "Higiene",
    "Farmácia",
    "Bebê",
    "Pet",
    "Papelaria",
    "Ferramentas",
    "Utilidades",
    "Outros"
];

const entidadesHtml = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
};

function escaparHtml(valor) {
    return String(valor ?? "").replace(/[&<>"']/g, caractere => entidadesHtml[caractere]);
}

function gerarId(prefixo) {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function idValido(valor) {
    return typeof valor === "string" && /^[a-zA-Z0-9:_-]+$/.test(valor);
}

function normalizarQuantidade(valor) {
    const numero = Number.parseInt(valor, 10);
    return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function normalizarValor(valor) {
    if (typeof valor === "number") {
        return Number.isFinite(valor) && valor > 0 ? valor : 0;
    }

    const texto = String(valor ?? "").trim();
    const numero = Number.parseFloat(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
    return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function normalizarValorBancario(valor) {
    const digitos = String(valor ?? "").replace(/\D/g, "");
    const centavos = Number.parseInt(digitos || "0", 10);
    const numero = centavos / 100;
    return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function formatarCampoMoeda(campo) {
    const digitos = campo.value.replace(/\D/g, "");

    if (!digitos) {
        campo.value = "";
        return;
    }

    const valor = Number.parseInt(digitos, 10) / 100;
    campo.value = valor.toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

    campo.setSelectionRange?.(campo.value.length, campo.value.length);
}

function formatarMoeda(valor) {
    return Number(valor || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function porcentagemProduto(produto) {
    if (!produto.ideal) return produto.atual > 0 ? 100 : 0;
    return Math.min(100, Math.round((produto.atual / produto.ideal) * 100));
}

function qtdParaComprar(produto) {
    return Math.max(0, produto.ideal - produto.atual);
}

function textoComparacao(valor) {
    return String(valor ?? "")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function normalizarCategoria(valor) {
    const categoria = String(valor ?? "").trim();
    if (!categoria) return "Outros";

    const categoriaExistente = CATEGORIAS_BASE.find(base => textoComparacao(base) === textoComparacao(categoria));
    return categoriaExistente || categoria;
}

function categoriasDisponiveis() {
    const categorias = new Set(CATEGORIAS_BASE);

    produtos.forEach(produto => categorias.add(normalizarCategoria(produto.categoria)));
    lista.forEach(item => categorias.add(normalizarCategoria(item.categoria)));
    compras.forEach(compra => compra.itens?.forEach(item => categorias.add(normalizarCategoria(item.categoria))));

    return [...categorias].sort((a, b) => {
        const ia = CATEGORIAS_BASE.indexOf(a);
        const ib = CATEGORIAS_BASE.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return a.localeCompare(b, "pt-BR");
    });
}

function opcoesCategoria(categoriaAtual = "Outros") {
    const atual = normalizarCategoria(categoriaAtual);
    const categorias = categoriasDisponiveis();
    if (!categorias.includes(atual)) categorias.push(atual);

    return `
      ${categorias.map(categoria => (
        `<option value="${escaparHtml(categoria)}" ${categoria === atual ? "selected" : ""}>${escaparHtml(categoria)}</option>`
    )).join("")}
      <option value="__nova__">+ Nova categoria...</option>
    `;
}

function alternarCategoriaCustom(prefixo) {
    const select = document.getElementById(`${prefixo}CategoriaSelect`);
    const input = document.getElementById(`${prefixo}CategoriaCustom`);
    if (!select || !input) return;

    const usandoNova = select.value === "__nova__";
    input.hidden = !usandoNova;
    if (usandoNova) input.focus();
}

function lerCategoriaModal(prefixo) {
    const select = document.getElementById(`${prefixo}CategoriaSelect`);
    const input = document.getElementById(`${prefixo}CategoriaCustom`);
    if (!select) return "";

    return select.value === "__nova__" ? input?.value.trim() || "" : select.value.trim();
}

function categoriaItemLista(item) {
    return encontrarProduto(item.produtoId)?.categoria || item.categoria || "Outros";
}

function agruparItensPorCategoria(itens) {
    const grupos = {};

    itens.forEach(item => {
        const categoria = normalizarCategoria(categoriaItemLista(item));
        if (!grupos[categoria]) grupos[categoria] = [];
        grupos[categoria].push(item);
    });

    return Object.keys(grupos)
        .sort((a, b) => {
            const ia = CATEGORIAS_BASE.indexOf(a);
            const ib = CATEGORIAS_BASE.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            return a.localeCompare(b, "pt-BR");
        })
        .map(categoria => ({ categoria, itens: grupos[categoria] }));
}

function agruparProdutosPorCategoria(produtosLista) {
    const grupos = {};

    produtosLista.forEach(produto => {
        const categoria = normalizarCategoria(produto.categoria);
        if (!grupos[categoria]) grupos[categoria] = [];
        grupos[categoria].push(produto);
    });

    return Object.keys(grupos)
        .sort((a, b) => {
            const ia = CATEGORIAS_BASE.indexOf(a);
            const ib = CATEGORIAS_BASE.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            return a.localeCompare(b, "pt-BR");
        })
        .map(categoria => ({ categoria, produtos: grupos[categoria] }));
}

function carregarArray(chave) {
    try {
        const dados = JSON.parse(localStorage.getItem(chave) || "[]");
        return Array.isArray(dados) ? dados : [];
    } catch (erro) {
        console.warn(`Dados inválidos em ${chave}. O app iniciou com a lista vazia.`);
        return [];
    }
}

function normalizarProduto(produto) {
    const nome = String(produto?.nome ?? "").trim();
    if (!nome) return null;

    return {
        id: idValido(produto?.id) ? produto.id : gerarId("produto"),
        nome,
        categoria: normalizarCategoria(produto?.categoria),
        atual: normalizarQuantidade(produto?.atual),
        ideal: normalizarQuantidade(produto?.ideal)
    };
}

function normalizarItemCompra(item) {
    const nome = String(item?.nome ?? "").trim();
    const comprar = normalizarQuantidade(item?.comprar);
    const produto = produtos.find(p => p.id === item?.produtoId) || produtos.find(p => p.nome === nome);

    if (!comprar) return null;

    return {
        produtoId: produto?.id || (idValido(item?.produtoId) ? item.produtoId : ""),
        nome: nome || "Item",
        categoria: produto?.categoria || normalizarCategoria(item?.categoria),
        avulso: Boolean(item?.avulso || !produto),
        comprar
    };
}

function normalizarCompra(compra) {
    const valor = normalizarValor(compra?.valor);
    if (!valor) return null;

    const data = new Date(compra?.data);

    return {
        id: idValido(compra?.id) ? compra.id : gerarId("compra"),
        data: Number.isNaN(data.getTime()) ? new Date().toISOString() : data.toISOString(),
        valor,
        obs: String(compra?.obs ?? "").trim(),
        itens: Array.isArray(compra?.itens) ? compra.itens.map(normalizarItemCompra).filter(Boolean) : []
    };
}

function normalizarItemLista(item) {
    const produto = produtos.find(p => p.id === item?.produtoId) || produtos.find(p => p.nome === item?.nome);
    const comprar = normalizarQuantidade(item?.comprar);

    if (!comprar) return null;

    return {
        id: idValido(item?.id) ? item.id : gerarId("lista"),
        produtoId: produto?.id || (idValido(item?.produtoId) ? item.produtoId : gerarId("lista")),
        nome: produto?.nome || String(item?.nome ?? "").trim() || "Item removido",
        categoria: produto?.categoria || normalizarCategoria(item?.categoria),
        comprar,
        comprado: Boolean(item?.comprado),
        avulso: Boolean(item?.avulso || !produto)
    };
}

function encontrarProduto(id) {
    return produtos.find(p => p.id === id);
}

function nomeItemLista(item) {
    return encontrarProduto(item.produtoId)?.nome || item.nome || "Item removido";
}

function tituloTela(titulo, subtitulo = "", acao = "") {
    const conta = usuarioAtual ? `
      <div class="account-actions">
        ${acao}
        <button class="compact" onclick="sair()">Sair</button>
      </div>
    ` : acao;

    return `
      <div class="view-header">
        <div>
          <h2>${escaparHtml(titulo)}</h2>
          ${subtitulo ? `<p>${escaparHtml(subtitulo)}</p>` : ""}
        </div>
        ${conta}
      </div>
    `;
}

function estadoVazio(titulo, texto = "") {
    return `
      <div class="empty-state">
        <strong>${escaparHtml(titulo)}</strong>
        ${texto ? `<span>${escaparHtml(texto)}</span>` : ""}
      </div>
    `;
}

function registrarTela(nome) {
    telaAtual = nome;

    if (navegandoPeloHistorico || !usuarioAtual || !window.history) return;

    const estado = { casaflow: true, tela: nome };

    if (!window.history.state?.casaflow) {
        window.history.replaceState(estado, "", window.location.href);
        return;
    }

    if (window.history.state.tela !== nome) {
        window.history.pushState(estado, "", window.location.href);
    }
}

function voltarTela() {
    if (telaAtual !== "home" && window.history?.state?.casaflow) {
        window.history.back();
        return;
    }

    home();
}

window.addEventListener("popstate", event => {
    if (!usuarioAtual) return;

    const destino = event.state?.casaflow ? event.state.tela : "home";
    const telas = {
        home,
        produtos: telaProdutos,
        contagem: telaContagem,
        lista: telaLista,
        historico: telaHistorico
    };

    navegandoPeloHistorico = true;
    fecharModal();
    (telas[destino] || home)();
    navegandoPeloHistorico = false;
});

// ===== MODAIS =====
function abrirModal({ titulo, corpo, rodape = "", tamanho = "" }) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" onclick="fecharModal(event)">
        <section class="modal ${tamanho}" role="dialog" aria-modal="true" aria-labelledby="modalTitle" onclick="event.stopPropagation()">
          <div class="modal-header">
            <h3 id="modalTitle">${escaparHtml(titulo)}</h3>
            <button class="icon-button" type="button" aria-label="Fechar" onclick="fecharModal()">×</button>
          </div>
          <div class="modal-body">
            ${corpo}
          </div>
          ${rodape ? `<div class="modal-actions">${rodape}</div>` : ""}
        </section>
      </div>
    `;
    modalRoot.classList.add("open");
    document.body.classList.add("modal-open");
    modalRoot.querySelector("[data-autofocus]")?.focus();
}

function fecharModal(event) {
    if (event && event.target !== event.currentTarget) return;

    modalRoot.classList.remove("open");
    modalRoot.innerHTML = "";
    document.body.classList.remove("modal-open");
    acaoConfirmacao = null;
}

function erroModal(mensagem) {
    const erro = document.getElementById("modalError");
    if (!erro) return;

    erro.textContent = mensagem;
    erro.hidden = false;
}

function mostrarAviso(titulo, mensagem) {
    abrirModal({
        titulo,
        corpo: `<p class="modal-text">${escaparHtml(mensagem)}</p>`,
        rodape: `<button class="primary" type="button" onclick="fecharModal()">OK</button>`
    });
}

function abrirConfirmacao({ titulo, mensagem, textoConfirmar = "Confirmar", classe = "danger", aoConfirmar }) {
    acaoConfirmacao = aoConfirmar;
    abrirModal({
        titulo,
        corpo: `<p class="modal-text">${escaparHtml(mensagem)}</p>`,
        rodape: `
          <button type="button" onclick="fecharModal()">Cancelar</button>
          <button class="${classe}" type="button" onclick="confirmarModal()">${escaparHtml(textoConfirmar)}</button>
        `
    });
}

function confirmarModal() {
    const acao = acaoConfirmacao;
    fecharModal();
    if (acao) acao();
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modalRoot.classList.contains("open")) fecharModal();
});

// ===== FIREBASE / LOGIN =====
function firebaseConfigurado() {
    const config = window.firebaseConfig;

    return Boolean(
        window.firebase &&
        config?.apiKey &&
        config?.projectId &&
        !String(config.apiKey).includes("COLE_") &&
        !String(config.projectId).includes("COLE_")
    );
}

function telaCarregando(mensagem = "Carregando...") {
    app.innerHTML = `
      <section class="auth-shell">
        <div class="auth-card">
          <h2>CasaFlow</h2>
          <p>${escaparHtml(mensagem)}</p>
        </div>
      </section>
    `;
}

function telaFirebasePendente() {
    app.innerHTML = `
      <section class="auth-shell">
        <div class="auth-card">
          <h2>Configurar Firebase</h2>
          <p>Preencha o arquivo firebase-config.js com a configuração do app Web criada no Firebase Console.</p>
          <div class="setup-list">
            <span>1. Crie um projeto no Firebase</span>
            <span>2. Ative Authentication por e-mail/senha</span>
            <span>3. Crie o Cloud Firestore</span>
            <span>4. Cole a configuração em firebase-config.js</span>
          </div>
        </div>
      </section>
    `;
}

function telaLogin() {
    telaAtual = "login";

    app.innerHTML = `
      <section class="auth-shell">
        <div class="auth-card">
          <div class="auth-brand">
            <img src="img/logo.png" alt="CasaFlow">
            <div>
              <h2>Entrar no CasaFlow</h2>
              <p>Seu estoque fica salvo na nuvem e separado por conta.</p>
            </div>
          </div>

          <form class="auth-form" onsubmit="entrar(event)">
            <label>
              E-mail
              <input id="loginEmail" type="email" autocomplete="email" required data-autofocus>
            </label>
            <label>
              Senha
              <input id="loginSenha" type="password" autocomplete="current-password" minlength="6" required>
            </label>
            <p class="modal-error" id="loginError" hidden></p>
            <button class="primary" type="submit">Entrar</button>
          </form>

          <div class="auth-links">
            <button type="button" onclick="criarConta()">Criar conta</button>
            <button type="button" onclick="enviarRecuperacaoSenha()">Esqueci a senha</button>
          </div>
        </div>
      </section>
    `;

    document.getElementById("loginEmail")?.focus();
}

function erroLogin(mensagem) {
    const erro = document.getElementById("loginError");
    if (!erro) return;

    erro.textContent = mensagem;
    erro.hidden = false;
}

function traduzirErroFirebase(erro) {
    const mensagens = {
        "auth/email-already-in-use": "Esse e-mail já tem uma conta.",
        "auth/invalid-email": "Digite um e-mail válido.",
        "auth/invalid-credential": "E-mail ou senha inválidos.",
        "auth/user-not-found": "Não encontrei uma conta com esse e-mail.",
        "auth/wrong-password": "Senha incorreta.",
        "auth/weak-password": "Use uma senha com pelo menos 6 caracteres.",
        "auth/network-request-failed": "Falha de conexão. Tente novamente."
    };

    return mensagens[erro?.code] || erro?.message || "Não foi possível concluir a ação.";
}

async function entrar(event) {
    event.preventDefault();

    const email = document.getElementById("loginEmail").value.trim();
    const senha = document.getElementById("loginSenha").value;

    try {
        telaCarregando("Entrando...");
        await auth.signInWithEmailAndPassword(email, senha);
    } catch (erro) {
        telaLogin();
        document.getElementById("loginEmail").value = email;
        erroLogin(traduzirErroFirebase(erro));
    }
}

async function criarConta() {
    const email = document.getElementById("loginEmail")?.value.trim();
    const senha = document.getElementById("loginSenha")?.value;

    if (!email || !senha) return erroLogin("Digite e-mail e senha para criar a conta.");

    try {
        telaCarregando("Criando conta...");
        await auth.createUserWithEmailAndPassword(email, senha);
    } catch (erro) {
        telaLogin();
        document.getElementById("loginEmail").value = email;
        erroLogin(traduzirErroFirebase(erro));
    }
}

async function enviarRecuperacaoSenha() {
    const email = document.getElementById("loginEmail")?.value.trim();
    if (!email) return erroLogin("Digite seu e-mail para receber a recuperação.");

    try {
        await auth.sendPasswordResetEmail(email);
        mostrarAviso("E-mail enviado", "Enviamos um link para redefinir sua senha.");
    } catch (erro) {
        erroLogin(traduzirErroFirebase(erro));
    }
}

async function sair() {
    try {
        await salvarFirebaseAgora();
        await auth.signOut();
    } catch (erro) {
        mostrarAviso("Erro ao sair", traduzirErroFirebase(erro));
    }
}

function referenciaDadosUsuario() {
    return db.collection("usuarios").doc(usuarioAtual.uid).collection("dados").doc("casaflow");
}

function dadosAtuais() {
    return {
        produtos,
        lista,
        compras,
        atualizadoEm: new Date().toISOString()
    };
}

function aplicarDados(dados = {}) {
    produtos = Array.isArray(dados.produtos) ? dados.produtos.map(normalizarProduto).filter(Boolean) : [];
    compras = Array.isArray(dados.compras) ? dados.compras.map(normalizarCompra).filter(Boolean) : [];
    lista = Array.isArray(dados.lista) ? dados.lista.map(normalizarItemLista).filter(Boolean) : [];
}

async function carregarDadosUsuario(user) {
    usuarioAtual = user;
    dadosCarregados = false;
    telaCarregando("Sincronizando seus dados...");

    const referencia = referenciaDadosUsuario();
    const snapshot = await referencia.get();

    if (snapshot.exists) {
        aplicarDados(snapshot.data());
    } else {
        const uidCache = localStorage.getItem("casaflowUserId");

        if (uidCache && uidCache !== user.uid) {
            produtos = [];
            lista = [];
            compras = [];
        }

        await referencia.set(dadosAtuais(), { merge: true });
    }

    dadosCarregados = true;
    localStorage.setItem("casaflowUserId", user.uid);
    salvarLocal();
    home();
}

function agendarSalvarFirebase() {
    if (!db || !usuarioAtual || !dadosCarregados) return;

    clearTimeout(timerSalvarFirebase);
    timerSalvarFirebase = setTimeout(salvarFirebaseAgora, 650);
}

async function salvarFirebaseAgora() {
    if (!db || !usuarioAtual || !dadosCarregados) return;

    clearTimeout(timerSalvarFirebase);
    timerSalvarFirebase = null;
    await referenciaDadosUsuario().set(dadosAtuais(), { merge: true });
}

async function iniciarFirebase() {
    if (!firebaseConfigurado()) {
        telaFirebasePendente();
        return;
    }

    firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore(firebaseApp);

    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    auth.onAuthStateChanged(async user => {
        try {
            if (!user) {
                usuarioAtual = null;
                dadosCarregados = false;
                telaLogin();
                return;
            }

            await carregarDadosUsuario(user);
        } catch (erro) {
            console.error(erro);
            telaLogin();
            erroLogin("Não consegui carregar seus dados. Confira as regras do Firestore e tente entrar novamente.");
        }
    });
}

// ===== DESFAZER =====
function snapshotEstado() {
    return JSON.parse(JSON.stringify({ produtos, lista, compras }));
}

function renderizarTelaAtual() {
    const telas = {
        home,
        produtos: telaProdutos,
        contagem: telaContagem,
        lista: telaLista,
        historico: telaHistorico
    };

    navegandoPeloHistorico = true;
    (telas[telaAtual] || home)();
    navegandoPeloHistorico = false;
}

function mostrarDesfazer(mensagem, snapshot) {
    snapshotDesfazer = snapshot;
    clearTimeout(timerDesfazer);

    toastRoot.innerHTML = `
      <div class="undo-toast" role="status">
        <span>${escaparHtml(mensagem)}</span>
        <button type="button" onclick="desfazerUltimaAcao()">Desfazer</button>
        <button class="toast-close" type="button" aria-label="Fechar" onclick="limparDesfazer()">×</button>
      </div>
    `;
    toastRoot.classList.add("open");
    timerDesfazer = setTimeout(limparDesfazer, 4000);
}

function limparDesfazer() {
    clearTimeout(timerDesfazer);
    timerDesfazer = null;
    snapshotDesfazer = null;
    toastRoot.innerHTML = "";
    toastRoot.classList.remove("open");
}

function desfazerUltimaAcao() {
    if (!snapshotDesfazer) return;

    produtos = snapshotDesfazer.produtos;
    lista = snapshotDesfazer.lista;
    compras = snapshotDesfazer.compras;
    salvar();
    limparDesfazer();
    fecharModal();
    renderizarTelaAtual();
}

// ===== DADOS =====
let produtos = carregarArray("produtos").map(normalizarProduto).filter(Boolean);
let compras = carregarArray("compras").map(normalizarCompra).filter(Boolean);
let lista = carregarArray("lista").map(normalizarItemLista).filter(Boolean);

// ===== SALVAR =====
function salvarLocal() {
    localStorage.setItem("produtos", JSON.stringify(produtos));
    localStorage.setItem("lista", JSON.stringify(lista));
    localStorage.setItem("compras", JSON.stringify(compras));
}

function salvar() {
    salvarLocal();
    agendarSalvarFirebase();
}

salvarLocal();

// ===== HOME =====
function totalMesAtual() {
    const mesAtual = new Date().getMonth();
    const anoAtual = new Date().getFullYear();

    return compras
        .filter(c => {
            const data = new Date(c.data);
            return data.getMonth() === mesAtual && data.getFullYear() === anoAtual;
        })
        .reduce((total, c) => total + c.valor, 0);
}

function chaveMes(data) {
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}`;
}

function rotuloMes(chave) {
    const [ano, mes] = chave.split("-");
    const data = new Date(Number(ano), Number(mes) - 1, 1);
    const nome = data.toLocaleDateString("pt-BR", { month: "long" });

    return `${nome.charAt(0).toUpperCase()}${nome.slice(1)}/${ano}`;
}

function home() {
    registrarTela("home");
    const pendentes = lista.filter(item => !item.comprado).length;
    const comprados = lista.filter(item => item.comprado).length;

    app.innerHTML = `
    ${tituloTela("CasaFlow", "Controle de estoque e compras da casa")}

    <section class="stats-grid">
      <div class="stat-card highlight">
        <span>Gasto do mês</span>
        <strong>R$ ${formatarMoeda(totalMesAtual())}</strong>
      </div>
      <div class="stat-card">
        <span>Itens</span>
        <strong>${produtos.length}</strong>
      </div>
      <div class="stat-card">
        <span>Na lista</span>
        <strong>${lista.length}</strong>
      </div>
    </section>

    ${lista.length ? `
      <section class="notice">
        <strong>Lista em andamento</strong>
        <span>${pendentes} faltando, ${comprados} pegos</span>
        <button class="compact primary" onclick="telaLista()">Abrir</button>
      </section>
    ` : ""}

    <section class="nav-grid">
      <button class="nav-button primary" onclick="telaContagem()">
        <span>📦</span>
        Fazer contagem
      </button>
      <button class="nav-button primary" onclick="telaLista()">
        <span>🛒</span>
        Lista de compras
      </button>
      <button class="nav-button" onclick="telaProdutos()">
        <span>⚙️</span>
        Gerenciar itens
      </button>
      <button class="nav-button" onclick="telaHistorico()">
        <span>📊</span>
        Histórico
      </button>
    </section>
  `;
}

// ===== GERENCIAR PRODUTOS =====
function telaProdutos() {
    registrarTela("produtos");
    const produtosOrdenados = [...produtos].sort((a, b) => qtdParaComprar(b) - qtdParaComprar(a));

    app.innerHTML = `
    ${tituloTela("Itens", `${produtos.length} cadastrados`, `<button class="compact primary" onclick="abrirModalProduto()">+ Novo item</button>`)}

    <div class="toolbar filters">
      <input id="produtoBusca" class="search-input" placeholder="Buscar item ou categoria" oninput="filtrarProdutos()">
      <select id="produtoCategoriaFiltro" onchange="filtrarProdutos()">
        <option value="">Todas as categorias</option>
        ${categoriasDisponiveis().map(categoria => `<option value="${escaparHtml(categoria)}">${escaparHtml(categoria)}</option>`).join("")}
      </select>
    </div>

    <section class="item-list" id="produtosLista">
      ${produtosOrdenados.length === 0 ? estadoVazio("Nenhum item cadastrado.", "Use o botão Novo item para começar.") : ""}

      ${produtosOrdenados.map(p => {
        const comprar = qtdParaComprar(p);
        const status = comprar ? `Comprar ${comprar}` : "Em dia";

        return `
          <article class="item-card" data-product-card
            data-nome="${escaparHtml(`${p.nome} ${p.categoria}`.toLowerCase())}"
            data-categoria="${escaparHtml(p.categoria)}">
            <div class="item-top">
              <div>
                <h3>${escaparHtml(p.nome)}</h3>
                <p><span class="category-chip">${escaparHtml(p.categoria)}</span> Atual ${p.atual} · Ideal ${p.ideal}</p>
              </div>
              <span class="pill ${comprar ? "warning" : "success"}">${status}</span>
            </div>
            <div class="progress-track" aria-hidden="true">
              <span style="width:${porcentagemProduto(p)}%"></span>
            </div>
            <div class="item-actions">
              <button onclick="abrirModalProduto('${escaparHtml(p.id)}')">Editar</button>
              <button class="danger ghost" onclick="removerItem('${escaparHtml(p.id)}')">Excluir</button>
            </div>
          </article>
        `;
    }).join("")}
    </section>

    <div class="footer-actions">
      <button onclick="voltarTela()">Voltar</button>
    </div>
  `;
}

function filtrarProdutos() {
    const termo = document.getElementById("produtoBusca")?.value.trim().toLowerCase() || "";
    const categoria = document.getElementById("produtoCategoriaFiltro")?.value || "";

    document.querySelectorAll("[data-product-card]").forEach(card => {
        const bateBusca = !termo || card.dataset.nome.includes(termo);
        const bateCategoria = !categoria || card.dataset.categoria === categoria;
        card.hidden = !bateBusca || !bateCategoria;
    });
}

function abrirModalProduto(id = "") {
    const produto = id ? encontrarProduto(id) : null;
    if (id && !produto) return mostrarAviso("Item não encontrado", "Esse item não está mais disponível.");
    const categoriaAtual = produto?.categoria || "Mercado";

    abrirModal({
        titulo: produto ? "Editar item" : "Novo item",
        corpo: `
          <form class="modal-form" onsubmit="salvarProdutoModal('${escaparHtml(id)}'); return false;">
            <label>
              Nome
              <input id="modalNome" value="${escaparHtml(produto?.nome || "")}" data-autofocus>
            </label>
            <label>
              Categoria
              <select id="modalCategoriaSelect" onchange="alternarCategoriaCustom('modal')">
                ${opcoesCategoria(categoriaAtual)}
              </select>
              <input id="modalCategoriaCustom" class="category-custom" placeholder="Nome da nova categoria" hidden>
              <small class="field-hint">Escolha uma categoria ou use Nova categoria.</small>
            </label>
            <div class="form-grid">
              <label>
                Atual
                <input id="modalAtual" type="number" min="0" step="1" inputmode="numeric" placeholder="0" value="${produto ? produto.atual : ""}">
              </label>
              <label>
                Ideal
                <input id="modalIdeal" type="number" min="0" step="1" inputmode="numeric" placeholder="0" value="${produto ? produto.ideal : ""}">
              </label>
            </div>
            <p class="modal-error" id="modalError" hidden></p>
          </form>
        `,
        rodape: `
          <button type="button" onclick="fecharModal()">Cancelar</button>
          <button class="primary" type="button" onclick="salvarProdutoModal('${escaparHtml(id)}')">Salvar</button>
        `
    });
}

function salvarProdutoModal(id = "") {
    const nome = document.getElementById("modalNome").value.trim();
    const categoriaDigitada = lerCategoriaModal("modal");
    const categoria = normalizarCategoria(categoriaDigitada);
    const atual = normalizarQuantidade(document.getElementById("modalAtual").value);
    const ideal = normalizarQuantidade(document.getElementById("modalIdeal").value);

    if (!nome) return erroModal("Digite um nome para o item.");
    if (!categoriaDigitada) return erroModal("Digite o nome da nova categoria.");

    const produto = id ? encontrarProduto(id) : null;

    if (id && !produto) return erroModal("Esse item não está mais disponível.");

    const snapshot = snapshotEstado();

    if (produto) {
        produto.nome = nome;
        produto.categoria = categoria;
        produto.atual = atual;
        produto.ideal = ideal;
        lista = lista.map(item => (
            item.produtoId === produto.id ? { ...item, nome: produto.nome, categoria: produto.categoria } : item
        ));
    } else {
        produtos.push({
            id: gerarId("produto"),
            nome,
            categoria,
            atual,
            ideal
        });
    }

    salvar();
    fecharModal();
    telaProdutos();
    mostrarDesfazer(produto ? "Item atualizado." : "Item cadastrado.", snapshot);
}

function removerItem(id) {
    const produto = encontrarProduto(id);
    if (!produto) return;

    abrirConfirmacao({
        titulo: "Excluir item",
        mensagem: `Excluir ${produto.nome}? Ele também será removido da lista de compras.`,
        textoConfirmar: "Excluir",
        aoConfirmar: () => {
            const snapshot = snapshotEstado();
            produtos = produtos.filter(p => p.id !== id);
            lista = lista.filter(item => item.produtoId !== id);
            salvar();
            telaProdutos();
            mostrarDesfazer("Item excluído.", snapshot);
        }
    });
}

// ===== CONTAGEM =====
function telaContagem() {
    registrarTela("contagem");
    const produtosVisiveis = produtos.filter(produtoBateFiltroContagem);
    const semResultado = produtos.length > 0 && produtosVisiveis.length === 0;

    app.innerHTML = `
    ${tituloTela("Contagem", "Atualize as quantidades antes de gerar a lista")}

    <div class="toolbar filters">
      <input id="contagemBusca" class="search-input" placeholder="Buscar item ou categoria"
        value="${escaparHtml(filtroContagemTexto)}" oninput="filtrarContagem()">
      <select id="contagemCategoriaFiltro" onchange="filtrarContagem()">
        <option value="">Todas as categorias</option>
        ${categoriasDisponiveis().map(categoria => `
          <option value="${escaparHtml(categoria)}" ${categoria === filtroContagemCategoria ? "selected" : ""}>
            ${escaparHtml(categoria)}
          </option>
        `).join("")}
      </select>
    </div>

    <section class="item-list">
      ${produtos.length === 0 ? estadoVazio("Nenhum item para contar.", "Cadastre itens primeiro.") : ""}
      <div id="contagemSemResultado" class="empty-state" ${semResultado ? "" : "hidden"}>
        <strong>Nenhum item encontrado.</strong>
        <span>Ajuste a busca ou a categoria.</span>
      </div>

      ${renderGruposContagem(produtosVisiveis)}
    </section>

    <div class="footer-actions">
      <button onclick="voltarTela()">Voltar</button>
      <button class="primary" onclick="finalizarContagem()" ${produtos.length ? "" : "disabled"}>Gerar lista</button>
    </div>
  `;
}

function produtoBateFiltroContagem(produto) {
    const termo = filtroContagemTexto.trim().toLowerCase();
    const categoria = filtroContagemCategoria;
    const texto = `${produto.nome} ${produto.categoria}`.toLowerCase();

    return (!termo || texto.includes(termo)) && (!categoria || produto.categoria === categoria);
}

function filtrarContagem() {
    filtroContagemTexto = document.getElementById("contagemBusca")?.value || "";
    filtroContagemCategoria = document.getElementById("contagemCategoriaFiltro")?.value || "";

    document.querySelectorAll("[data-count-card]").forEach(card => {
        const termo = filtroContagemTexto.trim().toLowerCase();
        const categoria = filtroContagemCategoria;
        const bateBusca = !termo || card.dataset.nome.includes(termo);
        const bateCategoria = !categoria || card.dataset.categoria === categoria;
        card.hidden = !bateBusca || !bateCategoria;
    });

    document.querySelectorAll("[data-count-group]").forEach(grupo => {
        const temVisivel = Array.from(grupo.querySelectorAll("[data-count-card]")).some(card => !card.hidden);
        grupo.hidden = !temVisivel;
    });

    const semResultado = document.getElementById("contagemSemResultado");
    if (semResultado) {
        const temVisivel = Array.from(document.querySelectorAll("[data-count-card]")).some(card => !card.hidden);
        semResultado.hidden = temVisivel || produtos.length === 0;
    }
}

function renderGruposContagem(produtosLista) {
    return agruparProdutosPorCategoria(produtosLista).map(grupo => `
      <div class="category-group" data-count-group>
        <div class="category-heading">
          <span>${escaparHtml(grupo.categoria)}</span>
          <small>${grupo.produtos.length}</small>
        </div>
        ${grupo.produtos.map(renderProdutoContagem).join("")}
      </div>
    `).join("");
}

function renderProdutoContagem(produto) {
    return `
      <article class="item-card count-card" data-count-card
        data-nome="${escaparHtml(`${produto.nome} ${produto.categoria}`.toLowerCase())}"
        data-categoria="${escaparHtml(produto.categoria)}">
        <div>
          <h3>${escaparHtml(produto.nome)}</h3>
          <p><span class="category-chip">${escaparHtml(produto.categoria)}</span> Ideal ${produto.ideal}</p>
        </div>
        <div class="quantity-control">
          <button class="icon-button" onclick="alterarQtd('${escaparHtml(produto.id)}', -1)">−</button>
          <input type="number" min="0" step="1" inputmode="numeric" value="${produto.atual}"
            onchange="atualizarQtd('${escaparHtml(produto.id)}', this.value)">
          <button class="icon-button" onclick="alterarQtd('${escaparHtml(produto.id)}', 1)">+</button>
        </div>
      </article>
    `;
}

function atualizarQtd(id, valor) {
    const produto = encontrarProduto(id);
    if (!produto) return;

    produto.atual = normalizarQuantidade(valor);
    salvar();
}

function alterarQtd(id, delta) {
    const produto = encontrarProduto(id);
    if (!produto) return;

    produto.atual = Math.max(0, produto.atual + delta);
    salvar();
    telaContagem();
}

function finalizarContagem() {
    if (!produtos.length) return mostrarAviso("Sem itens", "Cadastre itens antes de gerar uma lista.");

    const snapshot = snapshotEstado();

    lista = produtos
        .filter(p => p.atual < p.ideal)
        .map(p => ({
            id: gerarId("lista"),
            produtoId: p.id,
            nome: p.nome,
            categoria: p.categoria,
            comprar: p.ideal - p.atual,
            comprado: false,
            avulso: false
        }));

    salvar();
    telaLista();

    if (!lista.length) {
        mostrarAviso("Tudo em dia", "Nenhum item ficou abaixo da quantidade ideal.");
    }

    mostrarDesfazer("Lista gerada.", snapshot);
}

// ===== LISTA DE COMPRAS =====
function telaLista() {
    registrarTela("lista");
    const pendentes = lista.filter(i => !i.comprado);
    const comprados = lista.filter(i => i.comprado);

    app.innerHTML = `
    ${tituloTela(
        "Lista de compras",
        `${pendentes.length} faltando · ${comprados.length} pegos`,
        `<button class="compact primary" onclick="abrirModalItemAvulso()">+ Item avulso</button>`
    )}

    ${lista.length ? `
      <div class="toolbar action-toolbar">
        <button onclick="marcarTodos(true)" ${pendentes.length ? "" : "disabled"}>Marcar tudo</button>
        <button onclick="marcarTodos(false)" ${comprados.length ? "" : "disabled"}>Desmarcar</button>
        <button class="danger ghost" onclick="confirmarLimparLista()">Limpar</button>
      </div>
    ` : ""}

    <section class="section-block">
      <div class="section-title">Faltando</div>
      ${pendentes.length === 0 ? estadoVazio("Tudo pego.") : ""}

      ${renderGruposLista(pendentes)}
    </section>

    <section class="section-block">
      <div class="section-title">Pegos</div>
      ${comprados.length === 0 ? estadoVazio("Nenhum item marcado ainda.") : ""}

      ${renderGruposLista(comprados)}
    </section>

    <div class="footer-actions">
      <button onclick="voltarTela()">Voltar</button>
      <button class="primary" onclick="abrirModalCompra()" ${comprados.length ? "" : "disabled"}>Finalizar compra</button>
    </div>
  `;
}

function renderGruposLista(itens) {
    return agruparItensPorCategoria(itens).map(grupo => `
      <div class="category-group">
        <div class="category-heading">
          <span>${escaparHtml(grupo.categoria)}</span>
          <small>${grupo.itens.length}</small>
        </div>
        ${grupo.itens.map(item => renderItemLista(item)).join("")}
      </div>
    `).join("");
}

function abrirModalItemAvulso() {
    abrirModal({
        titulo: "Item avulso",
        corpo: `
          <form class="modal-form" onsubmit="salvarItemAvulsoModal(); return false;">
            <label>
              Nome
              <input id="modalAvulsoNome" data-autofocus>
            </label>
            <div class="form-grid">
              <label>
                Quantidade
                <input id="modalAvulsoQtd" type="number" min="1" step="1" inputmode="numeric" value="1">
              </label>
              <label>
                Categoria
                <select id="modalAvulsoCategoriaSelect" onchange="alternarCategoriaCustom('modalAvulso')">
                  ${opcoesCategoria("Outros")}
                </select>
                <input id="modalAvulsoCategoriaCustom" class="category-custom" placeholder="Nome da nova categoria" hidden>
              </label>
            </div>
            <p class="modal-error" id="modalError" hidden></p>
          </form>
        `,
        rodape: `
          <button type="button" onclick="fecharModal()">Cancelar</button>
          <button class="primary" type="button" onclick="salvarItemAvulsoModal()">Adicionar</button>
        `
    });
}

function salvarItemAvulsoModal() {
    const nome = document.getElementById("modalAvulsoNome").value.trim();
    const comprar = normalizarQuantidade(document.getElementById("modalAvulsoQtd").value);
    const categoriaDigitada = lerCategoriaModal("modalAvulso");
    const categoria = normalizarCategoria(categoriaDigitada);

    if (!nome) return erroModal("Digite o nome do item.");
    if (!comprar) return erroModal("Digite uma quantidade maior que zero.");
    if (!categoriaDigitada) return erroModal("Digite o nome da nova categoria.");

    const snapshot = snapshotEstado();

    lista.push({
        id: gerarId("lista"),
        produtoId: "",
        nome,
        categoria,
        comprar,
        comprado: false,
        avulso: true
    });

    salvar();
    fecharModal();
    telaLista();
    mostrarDesfazer("Item avulso adicionado.", snapshot);
}

function renderItemLista(item) {
    const index = lista.indexOf(item);
    const nome = nomeItemLista(item);
    const origem = item.avulso ? "Avulso" : "Estoque";
    const dica = item.comprado ? `${origem} · Toque para voltar` : `${origem} · Toque para marcar`;

    return `
      <article class="item-card list-row ${item.comprado ? "done" : ""}" role="button" tabindex="0"
        onclick="toggle(${index})" onkeydown="ativarItemLista(event, ${index})">
        <div class="list-main">
          <strong>${escaparHtml(nome)}</strong>
          <span>${dica}</span>
        </div>
        <span class="qty-pill">${item.comprar}</span>
        <button class="remove-button" aria-label="Remover ${escaparHtml(nome)}" title="Remover"
          onclick="event.stopPropagation(); removerDaLista(${index})">×</button>
      </article>
    `;
}

function ativarItemLista(event, i) {
    if (event.target.closest("button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    toggle(i);
}

function toggle(i) {
    if (!lista[i]) return;

    lista[i].comprado = !lista[i].comprado;
    salvar();
    telaLista();
}

function marcarTodos(comprado) {
    lista = lista.map(item => ({ ...item, comprado }));
    salvar();
    telaLista();
}

function removerDaLista(index) {
    const item = lista[index];
    if (!item) return;

    abrirConfirmacao({
        titulo: "Remover da lista",
        mensagem: `Remover ${nomeItemLista(item)} da lista de compras?`,
        textoConfirmar: "Remover",
        aoConfirmar: () => {
            const snapshot = snapshotEstado();
            lista.splice(index, 1);
            salvar();
            telaLista();
            mostrarDesfazer("Item removido da lista.", snapshot);
        }
    });
}

function confirmarLimparLista() {
    abrirConfirmacao({
        titulo: "Limpar lista",
        mensagem: "Remover todos os itens da lista de compras?",
        textoConfirmar: "Limpar",
        aoConfirmar: () => {
            const snapshot = snapshotEstado();
            lista = [];
            salvar();
            telaLista();
            mostrarDesfazer("Lista limpa.", snapshot);
        }
    });
}

function abrirModalCompra() {
    const itensComprados = lista.filter(item => item.comprado);
    if (!itensComprados.length) return mostrarAviso("Compra vazia", "Marque pelo menos um item comprado.");

    abrirModal({
        titulo: "Finalizar compra",
        corpo: `
          <div class="modal-summary">
            <span>${itensComprados.length} itens marcados</span>
            ${itensComprados.map(item => `
              <div>
                <strong>${escaparHtml(nomeItemLista(item))}</strong>
                <em>${escaparHtml(categoriaItemLista(item))} · ${item.comprar}</em>
              </div>
            `).join("")}
          </div>
          <form class="modal-form" onsubmit="registrarCompraModal(); return false;">
            <label>
              Valor total
              <input id="modalValor" class="money-input" type="text" inputmode="numeric" placeholder="0,00"
                autocomplete="off" oninput="formatarCampoMoeda(this)" data-autofocus>
            </label>
            <label>
              Observação
              <input id="modalObs" placeholder="Mercado, promoção, forma de pagamento">
            </label>
            <p class="modal-error" id="modalError" hidden></p>
          </form>
        `,
        rodape: `
          <button type="button" onclick="fecharModal()">Cancelar</button>
          <button class="primary" type="button" onclick="registrarCompraModal()">Registrar</button>
        `,
        tamanho: "modal-large"
    });
}

function registrarCompraModal() {
    const valor = normalizarValorBancario(document.getElementById("modalValor").value);
    const obs = document.getElementById("modalObs").value.trim();
    const itensComprados = lista.filter(item => item.comprado);

    if (!valor) return erroModal("Digite um valor maior que zero.");
    if (!itensComprados.length) return erroModal("Marque pelo menos um item comprado.");

    const snapshot = snapshotEstado();

    itensComprados.forEach(item => {
        const produto = encontrarProduto(item.produtoId);
        if (produto) produto.atual += item.comprar;
    });

    compras.push({
        id: gerarId("compra"),
        data: new Date().toISOString(),
        valor,
        obs,
        itens: itensComprados.map(item => ({
            produtoId: item.produtoId,
            nome: nomeItemLista(item),
            categoria: categoriaItemLista(item),
            avulso: Boolean(item.avulso),
            comprar: item.comprar
        }))
    });

    lista = lista.filter(item => !item.comprado);
    salvar();
    fecharModal();

    lista.length ? telaLista() : home();
    mostrarDesfazer(
        lista.length ? "Compra registrada. Pendentes continuam na lista." : "Compra registrada.",
        snapshot
    );
}

// ===== HISTÓRICO =====
function telaHistorico() {
    registrarTela("historico");
    const grupos = agruparPorMes();
    const totalGeral = compras.reduce((s, c) => s + c.valor, 0);

    app.innerHTML = `
    ${tituloTela("Histórico", `${compras.length} compras registradas`)}

    <section class="stats-grid">
      <div class="stat-card highlight">
        <span>Total geral</span>
        <strong>R$ ${formatarMoeda(totalGeral)}</strong>
      </div>
      <div class="stat-card">
        <span>Este mês</span>
        <strong>R$ ${formatarMoeda(totalMesAtual())}</strong>
      </div>
    </section>

    ${compras.length === 0 ? estadoVazio("Nenhuma compra registrada.") : ""}

    ${Object.keys(grupos).sort((a, b) => b.localeCompare(a)).map(mes => {
        const totalMes = grupos[mes].reduce((s, c) => s + c.valor, 0);

        const rotulo = rotuloMes(mes);

        return `
          <section class="month-group">
            <div class="month-header">
              <div>
                <h3>${rotulo}</h3>
                <span>R$ ${formatarMoeda(totalMes)}</span>
              </div>
              <button class="danger ghost compact" onclick="excluirMes('${mes}')">Excluir mês</button>
            </div>

            ${grupos[mes].map(renderCompra).join("")}
          </section>
        `;
    }).join("")}

    <div class="footer-actions">
      <button onclick="voltarTela()">Voltar</button>
    </div>
  `;
}

function renderCompra(compra) {
    return `
      <article class="purchase-row">
        <div class="purchase-head">
          <div>
            <strong>R$ ${formatarMoeda(compra.valor)}</strong>
            <span>${new Date(compra.data).toLocaleDateString("pt-BR")}${compra.obs ? ` · ${escaparHtml(compra.obs)}` : ""}</span>
          </div>
          <button class="delete-pill" aria-label="Excluir compra" onclick="excluirCompra('${escaparHtml(compra.id)}')">
            Excluir
          </button>
        </div>
        ${compra.itens.length ? `
          <div class="purchase-items">
            ${compra.itens.map(item => {
                const origem = item.avulso ? "avulso" : normalizarCategoria(item.categoria);
                return `
                  <span class="purchase-chip">
                    ${escaparHtml(item.nome)}
                    <small>${item.comprar} · ${escaparHtml(origem)}</small>
                  </span>
                `;
            }).join("")}
          </div>
        ` : ""}
      </article>
    `;
}

function agruparPorMes() {
    const grupos = {};

    compras.forEach(c => {
        const data = new Date(c.data);
        const chave = chaveMes(data);

        if (!grupos[chave]) grupos[chave] = [];

        grupos[chave].push(c);
    });

    return grupos;
}

function excluirCompra(id) {
    const compra = compras.find(c => c.id === id);
    if (!compra) return;

    abrirConfirmacao({
        titulo: "Excluir compra",
        mensagem: `Excluir a compra de R$ ${formatarMoeda(compra.valor)}? O estoque não será alterado.`,
        textoConfirmar: "Excluir",
        aoConfirmar: () => {
            const snapshot = snapshotEstado();
            compras = compras.filter(c => c.id !== id);
            salvar();
            telaHistorico();
            mostrarDesfazer("Compra excluída.", snapshot);
        }
    });
}

function excluirMes(mes) {
    abrirConfirmacao({
        titulo: "Excluir mês",
        mensagem: `Excluir todas as compras de ${rotuloMes(mes)}? O estoque não será alterado.`,
        textoConfirmar: "Excluir",
        aoConfirmar: () => {
            const snapshot = snapshotEstado();
            compras = compras.filter(c => {
                const data = new Date(c.data);
                const chave = chaveMes(data);
                return chave !== mes;
            });

            salvar();
            telaHistorico();
            mostrarDesfazer("Mês excluído.", snapshot);
        }
    });
}

// botão aparecer ao rolar
window.addEventListener("scroll", () => {
    const btn = document.getElementById("btnTop");
    btn.style.display = window.scrollY > 200 ? "inline-flex" : "none";
});

function voltarTopo() {
    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

// ===== INICIAR =====
iniciarFirebase();
