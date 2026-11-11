# Publicação no GitHub Pages

## Dois modos

- Local: `npm start` mantém a gravação no CSV e todas as ferramentas de treinamento.
- Publicado: `npm run build:pages` gera `dist/`, com jogos, câmera, referências e prática. Não depende da API local. O modo é definido no HTML gerado, sem alterar o HTML local.

O arquivo `dist/data/training.json` contém uma cópia da base global atual: exemplos estáticos, trajetórias, ordem dos exemplos e tolerâncias. Capturas provisórias são omitidas. Perfis, histórico de acesso e recordes não são exportados; continuam no navegador de cada visitante. A base publicada é pública e pode ser baixada.

Novos exemplos, exclusões, importações e ajustes de tolerância devem ser feitos localmente. Depois, gere e publique novamente. Uma imagem de referência não substitui exemplos de reconhecimento: sinais sem exemplos continuam com essa limitação.

## Publicar

1. Envie o projeto ao seu repositório, incluindo o CSV atualizado e os arquivos de mídia. Não envie `backups/`, `.venv/` nem outros arquivos pessoais.
2. Em **Settings → Pages**, selecione **GitHub Actions** como origem.
3. Em **Actions → Publish GitHub Pages → Run workflow**, execute a publicação.

O workflow gera e publica somente `dist/`. É manual: após novos treinamentos, envie as mudanças ao repositório e execute-o novamente. Também é possível hospedar o conteúdo de `dist/` em outro serviço estático. Não publique a raiz sem gerar esse modo.

Para conferir localmente, use um servidor HTTP estático apontado para `dist/`. Os caminhos suportam a subpasta de um repositório. A câmera requer permissão e HTTPS (ou localhost). O MediaPipe é carregado de uma CDN e requer conexão.

## Voltar ao estado anterior

Backup anterior à mudança: `backups/before-github-pages-source-20261111.zip`.
O ZIP foi verificado e contém 343 arquivos, incluindo código, CSV, mídias e documentos. Dependências reinstaláveis (`.venv`, `node_modules`), caches Python, histórico `.git` e backups anteriores foram excluídos. Dados de perfis/recordes no navegador não fazem parte desse ZIP.

Para testar o estado anterior sem perder trabalho novo, extraia o ZIP em uma pasta separada e execute `npm start` nela, com o servidor atual parado. A nova arquitetura não exige restaurar nada para treinar: `npm start` neste projeto já mantém o modo local.
