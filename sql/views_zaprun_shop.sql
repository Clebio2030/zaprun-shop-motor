/* =============================================================================
   ZapRun Shop — view do catálogo no ERP (Firebird)

   Aplicada AUTOMATICAMENTE pelo Motor a cada boot do serviço, comando a
   comando. Por isso, o dia em que este arquivo tiver DDL, ela precisa ser
   sempre CREATE OR ALTER VIEW, nunca CREATE VIEW.

   ⚠️  ESTE ARQUIVO ESTÁ SEM DDL DE PROPÓSITO.

   A view ZAPRUN_SHOP já existe no ERP do cliente, escrita fora daqui. Um
   CREATE OR ALTER chutado a partir de nomes de tabela que não conferimos
   SUBSTITUIRIA a view boa por uma quebrada no primeiro boot — e o catálogo
   inteiro sumiria da loja. Sem comandos executáveis, migrations.js registra
   "arquivo-vazio" em GET /status e não toca em nada.

   Para passar a versionar a view aqui:
     1. Leia o schema real: GET http://127.0.0.1:3002/diagnostico/colunas
        ?tabelas=PRODUTO,CODBARRA,PRECO,DEPOSITO,ESTOQUE,GRUPO
        (o Firebird recusa a criação inteira no PRIMEIRO nome errado — e cada
        nome errado custa uma ida e volta com alguém na frente da máquina)
     2. Escreva o CREATE OR ALTER respeitando o contrato abaixo
     3. Confira com GET /produtos?cdproduto=<um produto conhecido>

   ── CONTRATO: o que o Motor espera da view ───────────────────────────────────

   A view é PLANA. Ela devolve VÁRIAS linhas por produto — o produto cartesiano
   de códigos de barra × tabelas de preço × depósitos — e quem reduz isso a um
   objeto por produto é backend/src/motor/mapping.js. A view não precisa
   agrupar, deduplicar nem ordenar nada além de CDPRODUTO.

   | Coluna              | Tipo    | Obrigatória | Observação                      |
   |---------------------|---------|-------------|---------------------------------|
   | CDPRODUTO           | INTEGER | SIM         | identidade; linha sem ele é descartada |
   | PRODUTO_DESCRICAO   | TEXTO   | não         | nome no catálogo                |
   | GRUPO               | TEXTO   | não         | vira categoria no Shop          |
   | CODBARRA            | TEXTO   | não         | 1:N — ver nota abaixo           |
   | IDPRECO             | INTEGER | não         | 1:N — chave da tabela de preço  |
   | TABELA_PRECO        | TEXTO   | não         | 1:N — "CARTAO", "DINHEIRO"...   |
   | PRECO               | NUMERIC | não         | 1:N — sem ele, o preço é ignorado |
   | CDDEPOSITO          | INTEGER | não         | 1:N — chave do depósito         |
   | DEPOSITO_DESCRICAO  | TEXTO   | não         | 1:N                             |
   | SALDO               | NUMERIC | não         | 1:N — zero é dado válido        |
   | IDEMPRESA           | INTEGER | não         | só em ERP multiempresa          |

   Regras que não são negociáveis:

   • LEFT JOIN em tudo.
     Com INNER JOIN, produto sem código de barras — ou sem preço cadastrado —
     desaparece por completo do catálogo, em silêncio.

   • Toda coluna de TEXTO sai com CHARACTER SET OCTETS:
         CAST(p.DESCRICAO AS VARCHAR(150) CHARACTER SET OCTETS)
     Sem isso, o node-firebird decodifica bytes WIN1252 como UTF-8 e todo
     acento vira U+FFFD — perda IRREVERSÍVEL na leitura. Ver motor/encoding.js.

   • O CAST usa o tamanho DECLARADO da coluna.
     Um CAST menor que o dado não trunca em silêncio: derruba a leitura inteira
     com "string right truncation", e o ciclo não entrega nada.

   • CODBARRA é TEXTO, nunca número.
     EAN/GTIN admite zero à esquerda ("0001234567890") e um GTIN-14 chega perto
     do limite de inteiro seguro do JavaScript. Como número, o zero some e o
     código pode ser arredondado — e um produto com código errado é um produto
     que o leitor do caixa nunca acha.

   • IDEMPRESA entra em TODOS os JOINs, quando o ERP é multiempresa.
     Juntar preço ou saldo só por CDPRODUTO faz o estoque da empresa 1 aparecer
     no produto da empresa 2. Foi assim que o Motor de Orçamentos errou os itens
     antes de incluir IDEMPRESA no JOIN de ORCPROD.

   ── Esqueleto (ajuste os nomes ao ERP antes de descomentar) ──────────────────

   CREATE OR ALTER VIEW ZAPRUN_SHOP (
       CDPRODUTO, PRODUTO_DESCRICAO, GRUPO,
       CODBARRA,
       IDPRECO, TABELA_PRECO, PRECO,
       CDDEPOSITO, DEPOSITO_DESCRICAO, SALDO
   ) AS
   SELECT
       p.CDPRODUTO,
       CAST(p.DESCRICAO AS VARCHAR(150) CHARACTER SET OCTETS),
       CAST(g.DESCRICAO AS VARCHAR(60)  CHARACTER SET OCTETS),
       CAST(b.CODBARRA  AS VARCHAR(20)  CHARACTER SET OCTETS),
       t.IDPRECO,
       CAST(t.DESCRICAO AS VARCHAR(40)  CHARACTER SET OCTETS),
       t.VLVENDA,
       d.CDDEPOSITO,
       CAST(d.DESCRICAO AS VARCHAR(60)  CHARACTER SET OCTETS),
       e.SALDO
   FROM PRODUTO p
   LEFT JOIN GRUPO    g ON g.CDGRUPO    = p.CDGRUPO
   LEFT JOIN CODBARRA b ON b.CDPRODUTO  = p.CDPRODUTO
   LEFT JOIN PRECO    t ON t.CDPRODUTO  = p.CDPRODUTO
   LEFT JOIN ESTOQUE  e ON e.CDPRODUTO  = p.CDPRODUTO
   LEFT JOIN DEPOSITO d ON d.CDDEPOSITO = e.CDDEPOSITO;

   ============================================================================= */
