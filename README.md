# OrçaFácil

Gerador de orçamentos profissionais para prestadores de serviços — aplicativo web 100% no navegador.

> **Projeto demonstrativo de portfólio.** Todas as funcionalidades apresentadas funcionam de verdade; os dados ficam apenas no seu navegador (`localStorage`) e **nunca** são enviados a servidores.

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-0f766e)

## Visão geral

O **OrçaFácil** permite que freelancers e pequenas empresas:

1. Cadastrem os dados da própria empresa (com logotipo opcional)
2. Informem o cliente
3. Adicionem itens com quantidade e valor unitário
4. Apliquem desconto (R$ ou %) e acréscimo
5. Gerem um documento profissional para **visualizar**, **imprimir** ou **exportar em PDF**
6. Mantenham um **histórico** pesquisável de orçamentos no próprio navegador

## Funcionalidades

| Área | O que faz |
|------|-----------|
| Prestador | Nome, CPF/CNPJ, telefone, e-mail, endereço e logo local |
| Cliente | Nome, documento, contato e endereço |
| Itens | CRUD completo com subtotal automático |
| Valores | Subtotal, desconto (% ou R$), acréscimo e total em tempo real |
| Metadados | Número sequencial automático, data, validade, pagamento, prazo e observações |
| Status | Rascunho · Enviado · Aprovado · Recusado |
| Ações | Visualizar, imprimir, PDF, salvar, editar, duplicar, excluir, novo, demo |
| Histórico | `localStorage`, busca por cliente/número e filtro por status |
| UX | Responsivo, impressão limpa, toasts, confirmações, teclado e estados vazios |

## Tecnologias

- **HTML5**, **CSS3** e **JavaScript** puros (sem frameworks e sem build)
- **html2pdf.js** (CDN jsDelivr) apenas para geração de PDF
- Armazenamento: `localStorage`
- Tipografia: [DM Sans](https://fonts.google.com/specimen/DM+Sans) + [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif)

## Estrutura do projeto

```text
/
├── index.html          # Estrutura e views (editor, preview, histórico)
├── css/
│   └── styles.css      # Layout, tema, responsivo e @media print
├── js/
│   └── main.js         # Estado, cálculos, CRUD, PDF e localStorage
├── vercel.json         # Headers e opções de deploy na Vercel
├── netlify.toml        # Publish dir e headers na Netlify
├── LICENSE             # MIT
└── README.md
```

## Como executar localmente

Não há build nem dependências de Node.

### Opção 1 — abrir o arquivo

Abra `index.html` no navegador.

> A geração de PDF e as fontes usam CDN; é necessário internet para esses recursos.

### Opção 2 — servidor estático (recomendado)

```bash
# Python 3
python -m http.server 5500

# ou Node (npx)
npx --yes serve .
```

Acesse `http://localhost:5500`.

### Demonstração rápida

1. Clique em **Demo** no topo
2. Explore itens, descontos e totais (demo: 5% de desconto + R$ 150 de acréscimo)
3. Vá em **Visualizar** → **Imprimir** ou **Gerar PDF**
4. **Salvar** e confira o **Histórico**

## Deploy

Aplicação estática: publique a **pasta raiz** do projeto (onde está o `index.html`).

### Vercel

```bash
npx vercel
```

Ou importe o repositório no [Vercel Dashboard](https://vercel.com) — framework preset: **Other**, diretório de saída: raiz.

### Netlify

```bash
npx netlify deploy --prod --dir=.
```

Ou arraste a pasta em [Netlify Drop](https://app.netlify.com/drop). O arquivo `netlify.toml` já define `publish = "."`.

### GitHub Pages

1. Envie o repositório para o GitHub  
2. **Settings → Pages → Deploy from a branch**  
3. Branch `main` (ou `master`), pasta `/ (root)`  
4. Site em `https://<usuario>.github.io/<repo>/`

Os caminhos de `css/` e `js/` são relativos e funcionam em subpastas do GitHub Pages.

## Privacidade

- Nenhum backend
- Nenhum analytics embutido
- Nenhum envio de formulário a APIs próprias (apenas CDN da biblioteca de PDF e fontes do Google, quando online)
- Logo e orçamentos ficam no **localStorage** do dispositivo

Limpar os dados do site no navegador apaga o histórico.

## Atalhos e acessibilidade

- `Ctrl` / `⌘` + `S` — salvar orçamento (no editor)
- `Esc` — fechar modais
- Link “Ir para o conteúdo”, foco visível, labels e `aria-*` nos fluxos principais
- Versão de impressão oculta menus, botões e status interno do documento

## Limitações (propositalmente honestas)

- Dados não sincronizam entre dispositivos
- Capacidade limitada pelo `localStorage` do navegador (~5 MB típicos)
- PDF depende da renderização no cliente (html2canvas); logos SVG podem falhar no PDF — prefira PNG/JPG
- Projeto de demonstração — não substitui ERP fiscal/contábil

## Licença

MIT — veja o arquivo [LICENSE](./LICENSE). Use, adapte e mostre no portfólio livremente.

---

Feito como demonstração de interface comercial, UX e JavaScript vanilla.
