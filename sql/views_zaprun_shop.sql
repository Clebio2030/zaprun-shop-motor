/* =============================================================================
   ZapRun Shop — view do catálogo no ERP (Firebird / miautomec)

   Aplicada AUTOMATICAMENTE pelo Motor a cada boot do serviço
   (backend/src/motor/migrations.js). Por isso é sempre CREATE OR ALTER VIEW,
   nunca CREATE VIEW — e por isso mudar a view é uma release, não um acesso
   remoto a 100 máquinas.

   ── UMA MUDANÇA EM RELAÇÃO À VERSÃO ESCRITA NO CLIENTE ──────────────────────

   Toda coluna de TEXTO ganhou `CAST(... AS VARCHAR(n) CHARACTER SET OCTETS)`.
   A versão original não tinha nenhum, e isso PERDE ACENTUAÇÃO de forma
   irreversível:

     as colunas TEXT deste ERP são CHARACTER SET NONE contendo bytes WIN1252
     (0xE3 = ã, 0xE9 = é). O node-firebird decodifica campos NONE como UTF-8,
     então cada byte acentuado vira U+FFFD na LEITURA — e nenhum conserto
     posterior o recupera, porque o byte original já não existe mais.
     "CAFÉ EM PÓ" chega como "CAF? EM P?" e vai assim para a vitrine.

   Com OCTETS o driver devolve os bytes crus num Buffer, e
   backend/src/motor/encoding.js decodifica WIN1252 corretamente. É o mesmo
   tratamento que a view ZAPRUN_ORCAMENTOS usa (21 CASTs), no mesmo banco, e
   que a documentação de lá registra como "caro de acertar e fácil de regredir".

   ⚠️  OS TAMANHOS DOS CASTs SÃO GENEROSOS, NÃO CONFERIDOS.
   Um CAST MENOR que o dado não trunca em silêncio: derruba a leitura inteira
   com "string right truncation", e o ciclo não entrega nada. Um CAST MAIOR é
   sempre seguro. Por isso os valores abaixo são folgados. Para fixá-los nos
   tamanhos reais, leia o catálogo do ERP na máquina do cliente:

     GET http://127.0.0.1:3010/diagnostico/colunas?tabelas=PRODUTO,PRODUTO_CODBARRA,PRODUTOPRECO,TABELAPRECO,DEPOSITO,MOVIMENTO

   Confira o resultado com:

     GET http://127.0.0.1:3010/produtos?cdproduto=<um produto com acento no nome>

   ── OUTRAS TRÊS COISAS QUE VALE SABER ───────────────────────────────────────

   1. NÃO descomente o `HAVING SUM(m.qtdeatual) > 0`.
      A "dica de ouro" do original mandaria só depósitos com saldo positivo. Para
      o Shop isso é um defeito: saldo 0 é justamente o que marca o produto como
      ESGOTADO na vitrine. Com o HAVING ligado, o produto que zera some da lista
      de depósitos e o Shop não consegue distinguir "acabou" de "nunca soube" —
      ele continuaria anunciando o último saldo conhecido.

   2. `WHERE p.inativo = 0` esconde o produto inativado no ERP.
      O sync é upsert SEM exclusão: produto que some da view CONTINUA no catálogo
      do Shop, à venda. Desativar a partir da ausência é possível (o payload é o
      catálogo inteiro), mas só é seguro quando a entrega fecha com
      received == expectedTotal — desativar a partir de uma entrega truncada
      esvaziaria a loja do cliente por causa de um timeout de rede. Ver
      docs/03-contrato-api.md.

   3. A subconsulta de estoque agrega MOVIMENTO inteiro, a cada ciclo.
      `movimento` costuma ser a maior tabela do ERP, e o SUM/GROUP BY varre tudo
      de hora em hora. Se o ciclo começar a demorar, é aqui que se olha primeiro
      (FB_QUERY_TIMEOUT está em 300s). `_meta.linhas` em GET /produtos mede o
      tamanho do resultado.

   4. PRODUTO_CODBARRA tem lixo: muitas linhas guardam o próprio CDPRODUTO no
      lugar do código de barras (produto 1506 → codbarra "1506"). Descoberto em
      16/09/2026: a busca automática de imagem usa o código de barras para
      achar a foto REAL da embalagem, e "10" (o código interno do produto 10)
      casou com o EAN de um carro em outra base — a vitrine ia mostrar a foto
      errada. A CASE abaixo só deixa passar string numérica com o comprimento
      de um código de verdade (EAN-8, UPC-A/EAN-13, GTIN-14); tudo o que não
      bate vira NULL — ausência de código, não um código inventado. Nunca
      volte a fazer `CAST(pcb.codbarra AS VARCHAR(...))` puro aqui.

   5. PRODUTO_DESCRICAO é o NOME do produto (p.produto), não a descrição.
      O nome da coluna engana e já custou tempo. A descrição de verdade é
      p.memoobs, exposta desde 17/09/2026 como PRODUTO_OBS.

      memoobs costuma ser campo MEMO (BLOB SUB_TYPE TEXT). Dois cuidados:

      a) SUBSTRING antes do CAST. Sem ele, um texto maior que o VARCHAR
         derruba a leitura inteira com "string right truncation" — e o ciclo
         não entrega NADA (mesma armadilha dos CASTs, no topo deste arquivo).
         Com SUBSTRING o texto longo é cortado, que é o comportamento certo
         para uma vitrine.

      b) 500 caracteres, e não mais, porque ESTA VIEW É CARTESIANA: a
         descrição se repete em TODA linha do produto. Um item com 2 códigos,
         3 tabelas e 4 depósitos repete o texto 24 vezes. Num catálogo de
         4.000 produtos, cada 100 bytes a mais viram megabytes por ciclo.
         Quem desduplica é o mapping.js, mas o tráfego já aconteceu.

      Se o ERP do cliente não tiver a coluna memoobs, o CREATE OR ALTER falha,
      o Firebird MANTÉM a view anterior e o Motor continua rodando com ela
      (migrations.js captura o erro por comando e segue). A falha aparece no
      diagnóstico, não em produto sumido da vitrine.

   ── O CONTRATO ──────────────────────────────────────────────────────────────

   A view é PLANA e devolve o produto cartesiano dos LEFT JOINs:
   códigos de barra × tabelas de preço × depósitos. Um produto com 2 códigos,
   3 tabelas e 4 depósitos ocupa 24 linhas. Quem reduz isso a um objeto por
   produto — deduplicando cada dimensão pela sua chave — é
   backend/src/motor/mapping.js. A view não precisa agrupar nada.

   Sem IDEMPRESA: este ERP é de empresa única. O Motor trata a ausência da
   coluna como empresa 0 e segue normalmente.
   ============================================================================= */

CREATE OR ALTER VIEW ZAPRUN_SHOP(
    CDPRODUTO,
    PRODUTO_DESCRICAO,
    PRODUTO_OBS,
    GRUPO,
    CODBARRA,
    IDPRECO,
    TABELA_PRECO,
    PRECO,
    CDDEPOSITO,
    DEPOSITO_DESCRICAO,
    SALDO)
AS
SELECT
    p.cdproduto,
    CAST(p.produto  AS VARCHAR(500) CHARACTER SET OCTETS),
    /* Descrição do produto. SUBSTRING ANTES do CAST — ver a nota 5 no topo:
       sem ele um MEMO longo derruba o ciclo inteiro, e com ele apenas corta. */
    CAST(SUBSTRING(p.memoobs FROM 1 FOR 500) AS VARCHAR(500) CHARACTER SET OCTETS),
    CAST(p.grupo    AS VARCHAR(255) CHARACTER SET OCTETS),
    /* Só passa se, depois do CAST/TRIM, for uma string só de dígitos com
       comprimento de código de barras de verdade (8, 12, 13 ou 14). Qualquer
       outra coisa — inclusive o CDPRODUTO reaproveitado como "código" — vira
       NULL. Ver a nota 4 no cabeçalho. */
    CASE
      WHEN TRIM(CAST(pcb.codbarra AS VARCHAR(100) CHARACTER SET OCTETS))
             SIMILAR TO '[0-9]{8}|[0-9]{12,14}'
        THEN TRIM(CAST(pcb.codbarra AS VARCHAR(100) CHARACTER SET OCTETS))
      ELSE NULL
    END,
    pp.idpreco,
    CAST(tp.descricao AS VARCHAR(255) CHARACTER SET OCTETS),
    pp.preco,
    est.cddeposito,
    CAST(est.deposito_descricao AS VARCHAR(255) CHARACTER SET OCTETS),
    COALESCE(est.saldo, 0)
FROM produto p

/* 1. Códigos de barra (1:N) */
LEFT JOIN produto_codbarra pcb ON pcb.cdproduto = p.cdproduto

/* 2. Preços e tabelas (1:N) */
LEFT JOIN produtopreco pp ON pp.cdproduto = p.cdproduto
LEFT JOIN tabelapreco  tp ON tp.idpreco   = pp.idpreco

/* 3. Estoque consolidado por depósito (1:N)

   O INNER JOIN com deposito corta movimentação sem depósito correspondente, e
   os filtros descartam depósito de defeito, inativo, ou com nome vazio — que
   apareceriam na vitrine como um depósito sem nome. */
LEFT JOIN (
    SELECT
        m.cdproduto,
        m.cddeposito,
        d.deposito AS deposito_descricao,
        SUM(m.qtdeatual) AS saldo
    FROM movimento m
    INNER JOIN deposito d ON d.cddeposito = m.cddeposito
    WHERE d.defeito = 0
      AND d.inativo = 0
      AND d.deposito IS NOT NULL
      AND TRIM(d.deposito) <> ''
    GROUP BY m.cdproduto, m.cddeposito, d.deposito
    /* NÃO ligue um HAVING SUM(m.qtdeatual) > 0 aqui — ver a nota 1 no topo:
       saldo 0 é o que marca "esgotado" no Shop. */
) est ON est.cdproduto = p.cdproduto

WHERE p.inativo = 0;
