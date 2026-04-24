# Portal de Cobranca

Sistema web simples para cobranca com:

- login centralizado;
- vendedores vendo apenas a propria carteira;
- financeiro com botao para atualizar a base uma vez por dia;
- substituicao da base anterior ao concluir a nova carga;
- andamento de cobranca salvo no servidor.

## Arquivos principais

- `server.js`: servidor HTTP e API.
- `users.json`: usuarios simples do sistema.
- `scripts/extract_pdfs.py`: extrai os PDFs e gera a base consolidada.
- `data/titulos.json`: base atual.
- `data/progress.json`: andamento das cobrancas.

## Como subir

1. Rode:
   `node server.js`
2. Abra:
   `http://localhost:3000`

## Usuarios iniciais

- Financeiro: `financeiro / Snow@0806`
- Evinho: `evinho / FBF@2026`
- Felipe: `felipe / Snow@0806`
- Rafael: `rafael / FBF@2026`
- Simone: `simone / FBF@2026`

## Atualizacao diaria

1. Entre com o usuario do financeiro.
2. No bloco `Atualizacao diaria`, selecione os PDFs do dia.
3. O sistema aceita:
   - 4 arquivos no novo padrao: `Titulos - Evinho.pdf`, `Titulos - Felipe.pdf`, `Titulos - Rafael.pdf`, `Titulos - Simone.pdf`
   - ou 8 arquivos no padrao antigo: `Titulos vencidos - ...` e `Titulos à vencer - ...`
4. Clique em `Atualizar base`.
5. O sistema processa os arquivos, recria `data/titulos.json` e remove os PDFs/base anteriores da carga ativa.

## Observacao

Este modelo de usuarios e senha e simples, como voce pediu. Para publicar na internet, o proximo passo recomendado e trocar por banco de dados, hash de senha e HTTPS.
