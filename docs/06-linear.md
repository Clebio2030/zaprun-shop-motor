# Linear Sistemas

Segundo ERP do Motor (v1.1.0, 23/09/2026). Mesmo serviço, mesma porta, mesmo
updater e mesma release do Automec — o que muda é de onde o catálogo é lido,
escolhido por `ERP_TIPO=linear` no `backend/.env`.

## Onde está o banco

| | Automec | Linear |
|---|---|---|
| Banco | Firebird, na máquina/rede da loja | **MySQL 8.4 na nuvem da Linear** (Oracle Cloud) |
| Acesso | local | **VPN OpenVPN** da Linear — a máquina da loja precisa estar conectada |
| Endereço | `FB_HOST`/`FB_DATABASE` | `10.0.32.42:3306` (única rota que a VPN entrega) |
| Usuário | SYSDBA | usuário de **BI, só `SELECT`**: `<8 primeiros dígitos do CNPJ>_bi` |
| Banco | caminho do `.FDB` | `bd<CNPJ com 14 dígitos>` |
| Charset | WIN1252 (`CHARACTER SET OCTETS` na view) | utf8mb4 — sem tratamento especial |
| View | `ZAPRUN_SHOP`, aplicada no boot | **nenhuma**: o usuário de BI não cria view. A consulta mora no Motor (`backend/src/motor/erp/linear/consulta.js`) |

Primeira loja: CNPJ 17.124.086/0001-67 — `bd17124086000167` / `17124086_bi`.

## De onde vem cada campo

Conferido no banco real em 23/09/2026.

| Campo do Motor | Origem no Linear | Observação |
|---|---|---|
| `cdproduto` | `es1.es1_cod` | |
| `descricao` (nome) | `es1p.es1_desc` | 50 caracteres no Linear |
| `observacao` | `es1.es1_observacao` | nunca vai para a vitrine |
| `grupo` | `st_familia.tab_desc` via `es1p.es1_familia` | os 18 grupos (RESFRIADOS, BAZAR…) — o mesmo "Departamento" da `view_sitemercado` |
| `codigos_barra` | `es1a_precos.es1_codbarra` (1:N) | só GTIN válido: o código de balança dos pesáveis (`0000000000003`) é descartado — ver `gtinValido` |
| `precos` | `es1.es1_prvarejo` | uma tabela só: `{ idpreco: 1, tabela: "PRECO DE VENDA" }` |
| `estoque` | `es1.es2_qatu` | um depósito só: `{ cddeposito: 1, deposito: "LOJA" }`. A tabela `estoques` diverge em 8 mil produtos e NÃO é a que o Linear usa |
| `unidade` | `es1.es1_um` | UN, KG, SC, PC, MT |
| `promocao` | `es1.es1_prpromocao` + agenda `es1b` + `st_nomepromocao` | ver abaixo |

**Quais produtos:** `es1_ativo = '1' AND es1_lojavirtual = 1` — a mesma regra da
`view_sitemercado` do Linear. Quem tira um produto da loja online é o lojista,
desmarcando "loja virtual" no cadastro dele. Na primeira loja: 47.477
cadastrados, 14.343 ativos, **13.842 na loja virtual**; o ciclo leva ~0,6 s.

## Por que não a `view_sitemercado`

O Linear já mantém uma view para a SiteMercado, com o mesmo filtro. Mas o preço
dela é **o do Linear + 12%** (14.674 de 14.674 linhas conferidas) — é o preço
que a loja cobra na SiteMercado, não o de balcão. Também não traz unidade nem
as datas da promoção.

## Promoção

- `es1_prpromocao > 0` é o preço promocional que o PDV cobra hoje.
- Ele só é enviado se houver uma linha **ativa** em `es1b` para **hoje** com o
  mesmo valor. É ela que dá início, fim e nome (`st_nomepromocao`), e é o que
  protege contra o ERP ainda não ter zerado uma promoção vencida.
- "Hoje" é a data **da máquina do cliente**, passada como parâmetro — não o
  `CURDATE()` do MySQL, que pode estar em UTC.
- O Motor manda a promoção **como está no ERP**, mesmo maior que o preço. Quem
  decide se vira oferta é o servidor (`normalizeProduct.decidirOferta`): só
  quando **baixa** o preço. Na primeira loja, 28 de 273 promoções não baixavam
  (repolho igual ao preço; linha Super Globo 4,39 → 5,79).
- `promocao: null` quer dizer "o ERP controla oferta e este produto não está em
  nenhuma" — o servidor desmarca a caixinha. Campo **ausente** (Automec) quer
  dizer "não sei" — o servidor não mexe.

## Instalação

`INSTALAR.bat` → passo 3 → opção **2 - Linear Sistemas**. As perguntas são
feitas pelo `setup-env.js --linear` (não pelo `.bat`, porque a senha tem `#` e
`@`, e `!`/`%` são corrompidos pelo `set /p`). Ele sugere banco e usuário pelo
CNPJ, grava a senha entre aspas e **testa a conexão** no fim, explicando o erro
(VPN, senha, banco). O passo 4 (firebird.conf) é pulado.

## Armadilhas

| Armadilha | Consequência |
|---|---|
| Senha no `.env` sem aspas | `#` vira comentário, a senha chega cortada e o MySQL responde `Access denied` — parece senha errada da Linear |
| `require('mysql2')` no topo de um módulo carregado pelo Automec | o updater não roda `npm install`; a instalação Automec atualizada cai no boot com "Cannot find module" |
| Usar `CURDATE()` na agenda de promoções | às 21h de Brasília o MySQL em UTC já está no dia seguinte — promoção some 3h antes |
| Tentar senhas no MySQL em sequência | `max_connect_errors` pode bloquear o IP de NAT da VPN, compartilhado com a loja |
| Tratar `promocao` ausente como `null` | desmarcaria a oferta manual de todo produto do Automec |
