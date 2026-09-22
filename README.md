# Primeiros Sinais — piloto web de LIBRAS

Aplicação client-side em HTML, CSS e JavaScript Vanilla, com seis minigames, perfis locais, cronômetro, MediaPipe Hands e confirmação contínua de um segundo.

## Requisitos

- navegador atualizado com acesso à câmera;
- conexão com a internet para carregar o MediaPipe pela CDN;
- pasta `Libras-20260913T224959Z-1-001` presente junto ao aplicativo, pois suas mídias são usadas como referências;
- uma das opções abaixo para servir os arquivos em `localhost`.

O reconhecimento e os perfis rodam no navegador. O servidor local apenas entrega arquivos estáticos: não recebe imagens da câmera e não executa inferência.

## Executar — opção recomendada

Na raiz do projeto, usando Node.js 18 ou mais recente:

```powershell
node scripts/serve.js
```

Abra no navegador:

```text
http://127.0.0.1:5173
```

Autorize a câmera quando o navegador solicitar. Para encerrar o servidor, volte ao terminal e pressione `Ctrl+C`.

Não é necessário executar `npm install`: o projeto não possui dependências npm de runtime ou desenvolvimento.

### Se o comando `node` não funcionar

Confira a instalação em um novo PowerShell ou terminal do VS Code:

```powershell
node --version
npm --version
```

Este projeto requer Node 18 ou mais recente. Nesta máquina, a instalação do Windows está em `C:\Program Files\nodejs` e foi validada com Node `v24.19.0` e npm `11.17.0`.

Se o terminal estava aberto durante a instalação, feche-o e abra um novo para recarregar o `PATH`. Como alternativa direta no PowerShell:

```powershell
& "C:\Program Files\nodejs\node.exe" scripts\serve.js
```

Execute o comando a partir de `C:\projetos\projeto_LIBRAS`. Se aparecer uma mensagem informando que a porta 5173 já está em uso, tente primeiro abrir `http://127.0.0.1:5173`: normalmente já existe uma instância do servidor em execução.

## Executar — alternativa com Live Server

Se a extensão Live Server já estiver instalada no VS Code:

1. clique com o botão direito em `index.html`;
2. escolha **Open with Live Server**;
3. use a URL `http://localhost:...` aberta pela extensão;
4. autorize a câmera no navegador.

Use sempre a mesma origem durante os testes. Perfis e exemplos pessoais ficam no `localStorage`; `127.0.0.1:5173`, `localhost:5500` e `file://` possuem armazenamentos separados.

## Abertura direta do HTML

O arquivo `index.html` possui um bundle para abertura por duplo clique, mas esse caminho é apenas uma compatibilidade auxiliar. Permissões de câmera, carregamento de mídias locais, módulos e persistência em `file://` variam entre navegadores.

Para testar o reconhecimento pela webcam, use `localhost` por uma das duas opções anteriores. Não trate a abertura direta como o modo oficial de execução.

## Usar o piloto

1. Crie ou selecione um perfil.
2. Escolha um dos seis jogos. A câmera é o modo padrão.
3. Clique em **Ativar câmera**. Na primeira ativação da sessão, aguarde o aplicativo preparar as referências locais usando a mesma versão do MediaPipe da webcam.
4. Faça um sinal. A interface mostra a classe efetivamente identificada, por exemplo, **Detectado: A**. Esse diagnóstico funciona antes de iniciar a partida.
5. Clique em **Iniciar partida**. Um sinal só avança quando a classe correta mantém escore estritamente superior a 85% por pelo menos 1000 ms contínuos.
6. Se o reconhecimento estiver incerto, abra **Ver referência e ajustar à minha mão**. Escolha o sinal, confira a referência e salve exemplos pessoais. O aplicativo aguarda dois segundos para posicionamento e captura 1,2 segundo de pose estável.

Os exemplos pessoais guardam apenas landmarks normalizados no perfil local. A captura aprende a pose mostrada; ela não verifica se o sinal ensinado está linguisticamente correto.

### Letras e números disponíveis

- 23 letras estáticas usam exemplos do dataset local;
- J, X e Z usam sequências pessoais comparadas por DTW; precisam de gravações no perfil antes de jogar;
- o dataset original não contém numerais;
- jogos de números exigem exemplos pessoais de cada numeral da sequência antes do início.

### Modo debug

Habilite **Ativar modo debug** no dashboard para manter o reconhecimento real pela câmera e acrescentar controles de injeção manual. Segure `Espaço` ou o botão de injeção. Com foco no botão, `Enter` alterna a injeção contínua. **Injetar queda para 84%** testa o reinício da confirmação. As partidas de debug ficam separadas dos recordes normais, mesmo quando a câmera é usada.

## Estado do reconhecimento

O classificador web compara landmarks normalizados com exemplos rotulados sem receber a letra alvo. Há correção de escala, proporção da imagem e espelhamento. O valor exibido é um escore de semelhança, não uma probabilidade calibrada de acerto.

O dataset é pequeno: contém 137 registros, não possui numerais e 20 letras têm somente uma amostra. A aplicação é um piloto experimental; não é um avaliador confiável de fluência ou correção linguística em LIBRAS.

## Reconhecimento dinâmico: J, X e Z

O motor temporal roda integralmente no navegador. O rastreador continua sendo o MediaPipe; a classificação dinâmica passou das regras geométricas fixas para **comparação de sequências por Dynamic Time Warping (DTW)**. O classificador estático permanece inalterado. Não há Random Forest, TensorFlow.js ou servidor de inferência neste caminho.

### Gravar e testar

1. Entre em um jogo, ative a câmera e abra **Ver referência e ajustar à minha mão**, antes de iniciar a partida.
2. Selecione **J**, **X** ou **Z**, confira o vídeo disponível e a execução com um instrutor. A seleção também muda o sinal em teste antes da partida.
3. Clique em **Gravar um movimento**. Aguarde os dois segundos de preparação. Pare brevemente na posição inicial até aparecer **Pronto** sobre a câmera.
4. Faça o movimento completo e pare na posição final. A captura detecta início e fim, salva uma sequência e informa a duração. Não clique novamente para encerrar. Há até 15 segundos para concluir a captura.
5. Grave de **3 a 5 execuções corretas por classe**, com pequenas variações de velocidade e posição. Basta uma para habilitar a classe, mas isso não demonstra robustez. São mantidas as oito gravações mais recentes por classe; **Remover último movimento desta classe** permite desfazer uma captura ruim.
6. Para testar, repita o sinal **sem gravar**. O reconhecedor compara todas as classes dinâmicas cadastradas e pode responder **não reconhecida**. Abra **Diagnóstico dos movimentos** para ver a distância de cada classe. A comparação exibida ao gravar usa somente os exemplos anteriores, antes de adicionar a nova captura.
7. Escolha **Movimento incorreto (rejeição)** e grave contraexemplos: trajetórias invertidas, incompletas ou movimentos que estejam causando acertos indevidos. Eles competem com as letras; nunca contam como acerto.
8. Inicie a partida. Faça o movimento e **mantenha a pose final por mais um segundo** depois do reconhecimento. Uma sequência reconhecida uma vez não aprova duas letras consecutivas: é necessário executar o movimento novamente.

As instruções de captura e confirmação aparecem sobre a câmera, inclusive em telas pequenas. O modo debug usa o mesmo reconhecedor real; a injeção manual continua disponível e seus recordes ficam separados.

**Não acompanha um dataset dinâmico validado.** Os vídeos existentes são referências para observar; não são automaticamente convertidos em exemplos. Não usamos trajetórias sintéticas como treino de produção nem transplantamos sinais da ASL/LSF para LIBRAS. O piloto aprende o rótulo fornecido pelo usuário e não consegue verificar se o professor/exemplo ensinado está correto. Jogos normais avisam sobre classes sem exemplos antes de iniciar; a simulação continua disponível sem treino.

### Matemática e implementação

Fluxo: `MediaPipe → segmentação → normalização/re-amostragem → DTW entre exemplos → rejeição ou classe → confirmação temporal`.

- **Segmentação:** posição inicial estável por 240 ms, movimento e parada final de 300 ms. A sequência tem limite de 4,5 s e 160 frames; uma janela anterior de até 160 ms preserva o começo. Só 100 ms da pausa final entram no exemplo. Pausas longas no meio podem dividir o sinal, uma limitação desta versão.
- **Coordenadas:** cada amostra reúne 63 valores da pose local dos 21 landmarks e dois valores da trajetória do pulso. A pose é relativa ao pulso e à escala da palma em cada frame. A trajetória é relativa ao **primeiro** pulso e à **primeira** escala, preservando a translação da mão. Corrigimos proporção da imagem, invertemos X para corresponder ao espelho e padronizamos mãos esquerdas/direitas. Rotações significativas não são removidas porque podem distinguir sinais.
- **Profundidade:** o `z` do MediaPipe é relativo ao pulso; permanece na forma dos dedos com peso reduzido. Não representa a distância absoluta da mão até a câmera. O motor não usa `z` do pulso como prova de aproximação do usuário. Veja a [documentação oficial de Hands](https://chuoling.github.io/mediapipe/solutions/hands.html#multi_hand_landmarks).
- **Re-amostragem:** interpolação linear em instantes uniformes gera 32 amostras por sequência. A duração original também é armazenada. Isso normaliza a velocidade global; o DTW acomoda diferenças locais de velocidade. Não interpolamos sobre perda de tracking.
- **Custo local:** `c(a,b) = sqrt(dPose(a,b)^2 + (0.55 * ||trajetoria(a)-trajetoria(b)||)^2)`. `dPose` reutiliza a RMS ponderada do classificador estático: pontas dos dedos pesam 2 e o eixo Z pesa 0,45.
- **DTW exato restrito:** `D(i,j) = c(i,j) + min(D(i-1,j), D(i,j-1), D(i-1,j-1))`, dentro de uma banda diagonal de 25% (8 amostras). Dividimos o custo acumulado pelo comprimento do caminho selecionado. A memória é linear; com 32 amostras e até 32 exemplos, o trabalho é limitado e ocorre ao concluir o movimento. Esta implementação **não é FastDTW** e não reproduz integralmente os artigos.
- **Decisão:** por exemplo, calculamos `d = max(custoDTW, 0.6 * custoMedioDosExtremos)`, evitando que o alinhamento esconda início/fim incompatíveis. Escolhemos a menor distância por classe. `similaridade = exp(-0.5 * (d/0.22)^2)`; `separacao = clamp((dSegundo-dPrimeiro)/0.12, 0, 1)`; `escore = min(similaridade, 0.5+0.5*separacao)`. Sem segunda classe, usamos separação 1, o que torna especialmente importante gravar classes concorrentes e contraexemplos. Uma correspondência só é aceita acima de 0,85, e `UNKNOWN` sempre rejeita. Os limiares são iniciais, ainda sem calibração em uma base de validação.
- **Independência do alvo:** `MotionClassifier.predict(clip)` não recebe a letra solicitada. O jogo encaminha J/X/Z ao domínio temporal e compara a classe retornada ao alvo somente depois. Portanto, este é reconhecimento de sinais isolados dentro de um domínio, não transcrição contínua de toda a língua.
- **Continuidade:** depois de reconhecer a sequência, somente novos frames compatíveis com a pose final sustentam o escore por até 1,8 s. O `GameEngine` exige mais de 85% durante 1000 ms contínuos. Frame inválido, intervalo superior a 180 ms, troca de mão, mudança de pose ou troca de alvo revogam a evidência. O cronômetro geral continua correndo.

O nome `confidenceProbability` é preservado no contrato do jogo, mas o valor é um **escore de semelhança não calibrado**, não uma acurácia medida. A rejeição reduz falsos positivos; não garante que qualquer movimento desconhecido será rejeitado.

### Dados e módulos

- `js/dynamic.js`: `MotionSegmenter`, `MotionCapture`, `MotionClassifier`, `TemporalRecognizer`, DTW e validação do formato.
- `js/vision.js`: captura serial com MediaPipe e integração com o motor temporal.
- `js/storage.js`: `motionExamples` opcional no perfil existente; preserva poses estáticas e recordes anteriores. Recordes anteriores não são recalculados, portanto tempos obtidos com reconhecedores diferentes não são comparáveis rigorosamente.
- `js/trajectory.js`: heurísticas anteriores preservadas apenas como referência e regressão; não classificam as partidas atuais.
- `tests/dynamic.test.js`: geometria sintética, variação de velocidade/escala/espelhamento, rejeição, continuidade e persistência. Esses testes não medem acurácia com pessoas.

**Exportar movimentos (JSON)** salva apenas a versão do formato e exemplos normalizados por classe; não inclui nome do perfil, fotos, vídeos ou histórico. **Importar** adiciona exemplos ao perfil atual, limitados aos oito mais recentes por classe. O formato v1 exige 32 vetores de 65 valores e duração de 250 a 4500 ms. Arquivos acima de 2 MB, versões desconhecidas, classes não suportadas, valores não finitos e sequências inválidas são recusados antes da escrita. Falhas de cota do localStorage são informadas sem sucesso aparente. Mantenha uma exportação antes de substituir exemplos; limpar os dados do site apaga a coleção local.

### Limitações e próxima avaliação

Este primeiro incremento cobre **movimentos isolados de uma mão**, com início e fim deliberadamente pausados. Não reconhece frases, sinais com duas mãos, localização relativa ao corpo ou expressões faciais. Não resolve a oclusão de dedos do rastreador. Os limiares de movimento ainda precisam ser ajustados com vídeos reais, especialmente para movimentos pequenos como X e para câmeras lentas. A simetria entre mãos é uma hipótese deste vocabulário reduzido, não uma regra universal de LIBRAS.

Para avaliar a precisão, grave sessões diferentes das usadas como exemplos, inclua pessoas novas e movimentos incorretos, mantenha treino e teste separados por pessoa/sessão e meça confusão J/X/Z, rejeições incorretas, falsas aceitações e latência. A interface atual não automatiza essa avaliação. Nenhuma taxa dos artigos abaixo deve ser atribuída a este piloto.

## Artigos e projetos utilizados como referência

As implementações JavaScript desta etapa são próprias. Os trabalhos em LIBRAS e o projeto MediaPipe/DTW orientaram a escolha do método. As fontes de ASL e LSF foram consultadas para comparação arquitetural e planejamento; não fornecem os sinais nem os pesos usados aqui.

1. **Arcanjo, L. de S. et al. (2024). _Automatic Time-aware Recognition of Brazilian Sign Language Based on Dynamic Time Warping_. WebMedia 2024.** [Artigo completo, SBC](https://sol.sbc.org.br/index.php/webmedia/article/download/30299/30105/) · [Repositório dos autores](https://github.com/IMScience-PPGINF-PucMinas/libras-sign-recognition). Referência principal para combinar landmarks e alinhamento temporal em LIBRAS. O trabalho usa descritores angulares e FastDTW; nosso piloto usa coordenadas locais + trajetória do pulso e DTW exato restrito. Não reproduzimos sua avaliação nem importamos seus datasets. O repositório declara licença MIT; não copiamos seus arquivos Python.
2. **Sakoe, H.; Chiba, S. (1978). _Dynamic programming algorithm optimization for spoken word recognition_. IEEE Transactions on Acoustics, Speech, and Signal Processing, 26(1), 43–49.** [DOI: 10.1109/TASSP.1978.1163055](https://doi.org/10.1109/TASSP.1978.1163055). Referência clássica para alinhamento temporal por programação dinâmica e restrição do caminho. O acesso ao texto integral no IEEE não foi disponível nesta consulta; citada como fundamento bibliográfico, não como reprodução experimental.
3. **Guérin, G. _Sign-Language-Recognition--MediaPipe-DTW_.** [Código e descrição do autor](https://github.com/gabguerin/Sign-Language-Recognition--MediaPipe-DTW). Referência prática de reconhecimento por sequências MediaPipe e DTW, com exemplos franceses e descritores angulares; repositório com licença MIT. Adaptamos o conceito, mantendo a translação do pulso porque comparar somente a pose local perderia parte dos movimentos. Nenhum vídeo ou código foi importado.
4. **Belissen, V.; Braffort, A.; Gouiffès, M. (2020). _Dicta-Sign-LSF-v2: Remake of a Continuous French Sign Language Dialogue Corpus and a First Baseline for Automatic Sign Language Processing_. LREC 2020, pp. 6040–6048.** [Artigo e metadados na ACL Anthology](https://aclanthology.org/2020.lrec-1.740/). Consultado para distinguir reconhecimento isolado de processamento contínuo de LSF e orientar futuras avaliações. Não implementamos seu modelo nem incorporamos o corpus.
5. **Henkel, C. e colaboradores (2023). _1st place solution to the Google – American Sign Language Fingerspelling Recognition competition_.** [Repositório da solução](https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution) · [Contexto oficial da competição, TensorFlow Blog](https://blog.tensorflow.org/2023/05/american-sign-language-fingerspelling-recognition.html). Consultado como alternativa futura baseada em modelos temporais aprendidos, com mais dados e infraestrutura. Código publicado sob Apache-2.0; não copiamos código, pesos ou vocabulário de ASL.
6. **Google / MediaPipe. _Hands: Output e JavaScript Solution API_.** [Documentação oficial](https://chuoling.github.io/mediapipe/solutions/hands.html). Base da interpretação de coordenadas, profundidade relativa e handedness. Mantivemos a versão do runtime já usada pelo projeto (`@mediapipe/hands@0.4.1675469240`).

Referências consultadas em setembro de 2026. ASL, LSF e LIBRAS são línguas diferentes: técnicas de processamento podem inspirar a implementação; rótulos, exemplos e validação linguística precisam ser específicos de LIBRAS.

## Desenvolvimento

Executar todos os testes:

```powershell
node --test
```

Quando `dataset_libras.csv` ou as mídias de referência forem alterados, regenere o dataset do navegador e depois o bundle:

```powershell
node scripts/export-dataset.js
node scripts/build.js
```

Depois de qualquer alteração nos módulos de `js/`, regenere o bundle usado em `file://`:

```powershell
node scripts/build.js
```

Arquivos gerados que não devem ser editados manualmente:

- `js/dataset.js`, gerado por `scripts/export-dataset.js`;
- `js/app.bundle.js`, gerado por `scripts/build.js`.

Via HTTP, o aplicativo usa diretamente os ES Modules. O bundle existe somente para a compatibilidade auxiliar com `file://`.

## Diagnóstico das referências

Com o servidor local em execução, abra:

```text
http://127.0.0.1:5173/tests/reference-check.html
```

O diagnóstico reprocessa as fotos originais com MediaPipe JavaScript e verifica a integração com o classificador. Ele reutiliza o próprio acervo e, portanto, não mede generalização nem acurácia com pessoas novas.

## Documentação técnica

- [Auditoria e decisões técnicas](docs/AUDIT.md)
- [Dificuldades atuais e decisões de engenharia](docs/DIFFICULDADES_ATUAIS.md)

## Protótipo Python legado

Os arquivos `Libras.py`, `treinar.py`, `webcam.py`, `modelo_libras.pkl` e `hand_landmarker.task` pertencem ao protótipo científico anterior. Eles não participam da execução do Web App.

Esse pipeline não deve ser usado como instrução principal do projeto atual:

- `Libras.py` ainda contém um caminho absoluto antigo para o dataset e precisa ser configurado antes da execução;
- `modelo_libras.pkl` não contém as classes E, T e U;
- o modelo foi treinado com dados insuficientes para demonstrar generalização;
- o pickle Python não é carregado pelo navegador.

As dependências históricas estão em `requirements.txt`. Detalhes e limitações do legado constam na auditoria técnica.

## Autoria original

O protótipo científico foi desenvolvido no contexto acadêmico da Universidade Federal do Oeste do Pará (UFOPA) por:

- Fernanda Brito Saraiva;
- Franciéllen Sousa Araújo;
- Isabelle Vitória Santiago Mendonça;
- Joanna Marieli Trindade do Nascimento;
- Tatyana Franciele Brasil Machado.
