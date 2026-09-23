# Auditoria e decisões de arquitetura

## Atualização: reconhecimento real pela câmera

O mock descrito no histórico abaixo foi substituído no fluxo de câmera por `SignClassifier` (`js/classifier.js`). Permanece apenas no modo debug. A câmera passou a ser o padrão, com migração única das configurações antigas, sem apagar históricos ou recordes.

Inspeção efetiva do pickle: faltam **E, T e U** nas classes do Random Forest. O CSV contém 137 linhas; 20 letras têm apenas uma amostra, e não há numerais. Para A, por exemplo, o modelo antigo retorna 0,63 mesmo na própria referência, incompatível com o limiar de aprovação. Não se baixou o limiar para esconder essa deficiência.

O classificador atual exporta 60 exemplos estáticos do CSV, abrangendo 22 letras. J/K/X/Z seguem o fluxo temporal com exemplos de movimento por perfil. K saiu dos exemplos estáticos porque a referência em vídeo exige deslocamento da mão. O exportador versiona um hash do CSV e lê as proporções das mídias originais. `x` e `z` são corrigidos pela relação largura/altura antes da normalização pelo tamanho da palma. Sem essa correção, fotos verticais e webcam horizontal produzem geometrias incompatíveis.

Na primeira ativação da câmera por sessão, as fotos rotuladas são reprocessadas pelo **mesmo MediaPipe JavaScript** da webcam. Os exemplos extraídos substituem, para essas classes, os landmarks legados do Tasks/Python; se uma imagem falhar, mantém-se o exemplo CSV. H/Y continuam com seus frames CSV, pois suas referências são vídeos. K é ensinado por sequências de movimento. Os exemplos preparados são reutilizados em memória nas partidas seguintes.

Classificação por protótipo mais próximo por classe, com reflexão e tolerância de ±12 graus; o alvo esperado não entra no classificador. O escore combina distância absoluta e separação do segundo colocado. Semelhança geométrica não é probabilidade calibrada de ML: a interface usa o termo **semelhança**. O contrato `confidenceProbability` foi preservado para a engine e o limiar continua estritamente >0,85 por 1000 ms.

A tela separada de Treinamento permite capturar exemplos estáticos: 2 segundos de preparação e 1,2 segundo de leituras contínuas e estáveis, guardando cinco amostras por captura e até 12 por sinal/perfil. J/K/X/Z usam segmentação e DTW sobre trajetórias gravadas, com indicador **PRONTO** antes do movimento e **GRAVANDO** ao começar a sequência. Perda de mão ou lacunas reiniciam a coleta. O jogo exibe uma contagem de três segundos antes de iniciar o cronômetro. Há isolamento por perfil e separação entre os domínios alfabeto/números. Como o dataset não contém números, estes dependem de exemplos pessoais. O usuário é responsável por fornecer a execução correta; isso é calibração supervisionada, não validação linguística.

Há testes adicionais de reconhecimento das referências, escala, reflexão, proporção de imagem, ruído, rejeição de ambiguidade, classe errada versus alvo, captura estável e persistência. `tests/reference-check.html` prepara os exemplos e executa MediaPipe sobre as fotos originais para conferir o fluxo completo. Reusar o acervo de treino não mede generalização: a validação independente com diferentes sinalizantes permanece necessária.

Resultado histórico da versão estática anterior: **28 testes Node aprovados**. No diagnóstico MediaPipe JavaScript, **17/20 fotos identificadas corretamente acima de 85%** após preparação dos exemplos. Nas fotos I/N/S o rastreador não retornou landmarks nessa execução; o runtime mantém os exemplos CSV para essas classes quando a reextração falha. H/K/Y são referências em vídeo e não fazem parte desse teste de fotos; K agora usa reconhecimento temporal. Nenhuma dessas medidas representa acurácia com usuários novos. Fonte da API de reset entre fotos independentes: [declarações oficiais do pacote MediaPipe Hands](https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/index.d.ts).

---

## Histórico da primeira entrega (mock)

## Inventário real

Em 16/09/2026, a inspeção do diretório não encontrou HTML, CSS, JavaScript ou AGENTS.md aplicável. O legado consiste em `Libras.py`, `treinar.py`, `webcam.py`, dados CSV, modelo pickle, modelo MediaPipe Tasks e mídias por letra. Portanto, não havia setup de câmera web ou CSS para reciclar.

## Problemas observados

- `Libras.py`: caminho absoluto de dataset aponta para outro diretório (`codigoLibras`); limiar de detecção de 0,05; extração de frames isolados de vídeos. Perde a informação temporal necessária a sinais dinâmicos.
- `treinar.py`: Random Forest com 63 coordenadas por amostra e split aleatório de linhas. Frames próximos de um mesmo vídeo podem cair em treino e teste, inflando a avaliação. Poucas amostras/classes comprometem a estratificação. É necessário separar por pessoa e sessão de captura.
- `webcam.py`: `predict` sem probabilidade, limiar ou estabilidade temporal; qualquer frame muda o resultado. Não diferencia movimento de pose. A mensagem de saída indica `t`, mas o código espera `q`.
- O pipeline Python, pickle e APIs OpenCV não executam diretamente em um navegador. Não existe equivalência automática entre esse classificador e TensorFlow.js.

## Reaproveitamento

Preservados os scripts científicos, dataset, pesos e mídias como material de pesquisa, sem executá-los ou carregá-los no web app. Reaproveitados conceitualmente os 21 landmarks, os índices anatômicos e a normalização em relação à mão. Nenhum código legado foi importado para a aplicação. Não havia lixo HTML/CSS/JS a apagar.

## Nova implementação

| Módulo | Responsabilidade |
| --- | --- |
| `js/storage.js` | Perfis indexados pelo nome normalizado, acessos, configuração e menores tempos |
| `js/games.js` | Seis estratégias de sequência e dicionário de 28 palavras |
| `js/engine.js` | Máquina de estados e confirmação contínua |
| `js/trajectory.js` | Validação de landmarks e heurísticas legadas, fora do fluxo atual de jogo |
| `js/dynamic.js` | Segmentação de movimento, exemplos J/K/X/Z, DTW e rejeição de sequências incertas |
| `js/vision.js` | Câmera, MediaPipe CDN, inferência serial e adaptador mock |
| `js/app.js` | Navegação, renderização DOM, acessibilidade e controle da partida |
| `js/boot.js` | ES Modules em HTTP; bundle gerado para abertura direta |

Estados da partida: `idle → running → finished`; saída voluntária leva a `cancelled`. A interface executa uma contagem visual de três segundos antes de chamar `start`. O relógio usa `performance.now()`, inicia ao fim da contagem e é congelado ao processar o frame final. `requestAnimationFrame` apenas exibe o tempo: nunca aprova sinais sem observações novas.

A confirmação começa em zero no primeiro frame com confiança estritamente >0,85. Qualquer classificação errada, ausência de mão ou confiança <=0,85 a reinicia. Lacunas >180 ms, frames atrasados/duplicados, aba oculta e perda de foco também invalidam a confirmação. Esse teto é conservador e pode dificultar dispositivos com inferência abaixo de aproximadamente 6 FPS. A aprovação acontece no primeiro frame válido em que decorreram pelo menos 1000 ms; a resolução real depende do FPS e do agendador do navegador. Não é possível observar fisicamente todos os milissegundos entre frames.

## Visão: alcance e limites

- O mock retorna `{ targetClass, confidenceProbability, timestamp }`. Sem injeção explícita, retorna confiança zero. A existência de landmarks não equivale a reconhecer LIBRAS.
- A simulação é visível, controlada pelo usuário e usa o mesmo buffer temporal. Os recordes ficam em `demoBestTimes`; os experimentais em `bestTimes`, ambos por minigame.
- `detectZMovement`, `detectJMovement` e `detectXMovement` correspondem às funções solicitadas `verificarMovimentoZ/J/X`, usando nomenclatura técnica em inglês. O Z contém três segmentos e **duas** mudanças internas de direção.
- Após reconhecer uma trajetória, a heurística exige pose terminal e localização estáveis em cada novo frame por 1 segundo. Isso evita exigir que um movimento inteiro seja refeito a cada frame. Perda da pose, identidade ou rastreamento revoga a evidência; ela não é um acerto enfileirado.
- O valor 0,90 das heurísticas é uma pontuação experimental fixa de evidência geométrica, não uma probabilidade calibrada por modelo neural.
- Vídeo e canvas recebem `scaleX(-1)`; as coordenadas geométricas recebem `x'=1-x`. O rótulo de lateralidade do MediaPipe é corrigido porque a entrada enviada ao modelo não está espelhada.
- Z do MediaPipe Hands é relativo ao pulso, com valores menores em direção à câmera. Não mede distância absoluta ao usuário. X usa flexão e variação relativa de profundidade; precisa de calibração com usuários reais.
- As trajetórias descritas no escopo não substituem validação linguística. O alfabeto real pode exigir movimentos adicionais; não se afirma que todas as demais letras sejam linguisticamente estáticas.
- Não há modelo TensorFlow.js treinado neste piloto. Para integração futura, substituir `StaticClassifierMock.predict` por um adaptador que produza a classe **predita pelo modelo**, sem forçar a classe esperada, normalizando coordenadas conforme o treino. O roteamento J/Z/X continua fora desse adaptador.

Referência técnica consultada: [documentação oficial MediaPipe Hands](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/hands.md), incluindo normalização, profundidade relativa, lateralidade e API JavaScript.

## Execução e privacidade

Sem frameworks, dependências npm, backend ou uploads. A CDN carrega JavaScript/WASM/modelos ao ativar a câmera; os frames são processados no navegador. Internet é necessária para esse carregamento. `file://` usa bundle já incluído, mas câmera e persistência nesse esquema dependem do navegador; Live Server/localhost é o caminho recomendado. Perfis são locais à origem, sem autenticação, e não migram automaticamente entre `file://`, portas, navegadores ou dispositivos.

## Verificação

Testes de unidade cobrem os limites temporais 999/1000 ms, queda a 84%, limite exato de 85%, dados inválidos, frames perdidos/atrasados, cancelamento, conclusão única, relógio contínuo, seis sequências, unicidade, isolamento de perfis, quota/corrupção, recorde estritamente menor, espelhamento, FIFO e trajetórias sintéticas positivas/negativas. Esses testes não medem acurácia linguística nem substituem uma avaliação presencial com webcam e sinalizantes.

No navegador local foram verificados criação/seleção de perfil, conclusão de uma partida simulada, exibição de novo recorde e persistência após recarregar. O layout foi inspecionado em viewport de 390 px sem transbordamento horizontal. A política de segurança do navegador de automação bloqueou abrir URLs `file://`; portanto, a abertura direta foi preparada e o bundle validado sintaticamente, mas não testada por essa automação. Webcam física e permissões de câmera não foram validadas nesta sessão.
