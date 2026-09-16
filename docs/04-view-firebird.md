# A view do ERP

O Motor lê **uma** view no Firebird do cliente: `ZAPRUN_SHOP`. É a única
superfície de contato com o ERP — nenhuma tabela é lida diretamente, nada é
escrito.

O contrato completo, coluna a coluna, vive no cabeçalho de
[`sql/views_zaprun_shop.sql`](../sql/views_zaprun_shop.sql). Este documento
explica o **porquê** das regras que estão lá.

## A view é plana, e isso é de propósito

A view não agrupa nada. Ela devolve o produto cartesiano dos relacionamentos
1:N — códigos de barra × tabelas de preço × depósitos — e quem reduz isso a um
objeto por produto é `backend/src/motor/mapping.js`.

Um produto com 2 códigos de barra, 3 tabelas de preço e 4 depósitos ocupa
**24 linhas**:

```
CDPRODUTO  CODBARRA        IDPRECO  TABELA    CDDEPOSITO  SALDO
8390       7908572802578   1        CARTAO    1004        319.19
8390       7908572802578   1        CARTAO    1005          0.00
8390       7908572802578   2        DINHEIRO  1004        319.19   ← repete
8390       7891234567890   1        CARTAO    1004        319.19   ← repete
...
```

Poderia a view agrupar, com `LIST()` ou subqueries? Poderia — e seria pior. SQL
de agrupamento no Firebird do cliente é código que só roda na máquina dele, que
ninguém consegue testar daqui, e que precisa de release de view para cada ajuste.
Em JavaScript o agrupamento tem 41 testes rodando em qualquer máquina. **A view
faz o que só ela pode fazer (ler o ERP); o resto sobe para onde é testável.**

Custo de manter: `GET /produtos` devolve `_meta.linhas` e `_meta.produtos` lado
a lado justamente para medir esse inchaço em produção.

## As cinco regras que não se negociam

### 1. LEFT JOIN em tudo

Com `INNER JOIN`, produto sem código de barras — ou sem preço cadastrado —
desaparece do catálogo por completo, e em silêncio. O cliente descobre pela
reclamação de que "sumiu produto da loja", semanas depois.

### 2. Texto sai com `CHARACTER SET OCTETS`

```sql
CAST(p.DESCRICAO AS VARCHAR(150) CHARACTER SET OCTETS)
```

As colunas TEXT do ERP são `CHARACTER SET NONE` com bytes WIN1252 (`0xE3` = ã).
O node-firebird decodifica campos NONE como UTF-8, então cada byte de acento
vira U+FFFD — perda **irreversível na leitura**, que nenhum conserto posterior
recupera. Com OCTETS o driver devolve os bytes crus e
`backend/src/motor/encoding.js` decodifica corretamente.

Se um acento aparecer errado no Shop, o problema está **na view**, não no
Motor.

### 3. O `CAST` usa o tamanho declarado da coluna

Um `CAST` menor que o dado não trunca em silêncio: ele derruba a leitura inteira
com *"string right truncation"*, e o ciclo não entrega nada. Leia os tamanhos
reais antes de escrever:

```
GET http://127.0.0.1:3010/diagnostico/colunas?tabelas=PRODUTO,CODBARRA,PRECO,DEPOSITO,ESTOQUE
```

Essa rota lê apenas o catálogo do Firebird (`RDB$RELATION_FIELDS`) — nenhum dado
de cliente passa por ela. Existe porque o Firebird recusa a criação inteira da
view no **primeiro** nome errado, e sem ela cada nome errado custava uma ida e
volta com alguém na frente da máquina do cliente.

### 4. `CODBARRA` é texto, nunca número

EAN/GTIN admite zero à esquerda (`0001234567890`) e um GTIN-14 chega perto do
limite de inteiro seguro do JavaScript. Como número, o zero some e o código pode
ser arredondado — e um produto com o código errado é um produto que o leitor do
caixa nunca encontra.

O Motor trata `"0"` e `"000000"` como *sem código*: é assim que o ERP marca
ausência, e cadastrar isso criaria produtos diferentes com o mesmo código.

### 5. `IDEMPRESA` entra em todos os JOINs (se o ERP for multiempresa)

Juntar preço ou saldo só por `CDPRODUTO` faz o estoque da empresa 1 aparecer no
produto da empresa 2. Foi exatamente esse o defeito no Motor de Orçamentos antes
de `IDEMPRESA` entrar no JOIN de `ORCPROD`.

A coluna é **opcional**: sem ela, o Motor trata tudo como empresa única. Com
ela, recorta pelo que o token autoriza.

## Por que o arquivo `.sql` está sem DDL

`migrations.js` aplica `sql/views_zaprun_shop.sql` a **cada boot** do serviço —
é assim que uma view nova chega à frota, pelo release. Isso significa que um
`CREATE OR ALTER VIEW` escrito por chute **substituiria a view boa do cliente
por uma quebrada, no primeiro boot depois da atualização**.

Como a `ZAPRUN_SHOP` já existe no ERP e foi escrita fora daqui, o arquivo carrega
o contrato e o esqueleto comentado, mas nenhum comando executável. Sem comandos,
`migrations.js` registra `arquivo-vazio` em `GET /status` e não toca em nada.

Para passar a versionar a view aqui: leia o schema real (regra 3), escreva o
`CREATE OR ALTER`, e confira com `GET /produtos?cdproduto=<um produto conhecido>`
antes de publicar a release.

## Saldo zero não é ausência de saldo

`SALDO = 0` é informação legítima: "o depósito existe e está zerado". É o que
deixa o Shop marcar o produto como **esgotado** em vez de escondê-lo da vitrine.
Por isso o Motor decide se a linha tem estoque pelo **depósito** (`CDDEPOSITO`
ou o nome), nunca pelo valor do saldo — um filtro `!saldo` apagaria justamente
os zeros, que são os que importam.
