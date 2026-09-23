# Dificuldades atuais e decisões de engenharia

## Objetivo deste documento

Este documento descreve os principais riscos e limitações do piloto **Primeiros Sinais**, considerando o projeto como produto educacional, aplicação web e sistema de visão computacional.

O objetivo não é apenas listar problemas. Cada seção procura responder:

1. O que observamos hoje?
2. Qual é a causa provável?
3. Que risco isso cria?
4. Que evidência ainda falta?
5. Qual decisão de engenharia depende dessa evidência?

Este é um retrato do piloto em 16/09/2026. As métricas aqui citadas não devem ser apresentadas como acurácia do produto sem uma avaliação independente.

## Resumo executivo

O aplicativo já possui uma base funcional: perfis locais, seis modos de prática, câmera com MediaPipe, confirmação temporal, recordes, reconhecimento por exemplos e heurísticas para movimentos. O problema central está na qualidade da evidência usada para reconhecer sinais.

O dataset atual contém 137 linhas. Vinte letras possuem apenas uma amostra, não há numerais e parte dos sinais dinâmicos veio de frames correlacionados do mesmo vídeo. Isso é insuficiente para demonstrar generalização entre pessoas, câmeras, iluminações e formas de executar um sinal.

Além disso, landmarks são uma representação incompleta. Quando um dedo encobre outro, o MediaPipe estima articulações que não aparecem na imagem. Sinais visualmente próximos, como R e U, podem terminar com coordenadas muito semelhantes. Um classificador melhor pode reduzir erros, mas não consegue recuperar informação que o extrator de landmarks perdeu.

As decisões com maior impacto são, nesta ordem:

1. definir e validar linguisticamente quais sinais e variações o piloto ensinará;
2. construir um protocolo de coleta e avaliação com participantes diferentes;
3. estabelecer uma linha de base mensurável;
4. comparar modelos de landmarks, imagem e sequência;
5. somente depois escolher a arquitetura definitiva de inferência no navegador.

## Estado técnico atual

```text
webcam
  ↓
MediaPipe Hands
  ↓
21 landmarks (x, y, z estimado)
  ├─ pose estática → comparação com exemplos normalizados
  ├─ J / X / Z → heurísticas de trajetória
  └─ exemplo pessoal → localStorage do perfil
        ↓
classe + escore de semelhança
        ↓
> 85% continuamente por 1000 ms
        ↓
avanço no jogo
```

O Random Forest do protótipo Python não participa da aplicação web. O modelo pickle não contém E, T e U, e sua confiança é inferior a 85% para várias amostras do próprio conjunto de dados. A versão web utiliza atualmente classificação pelo exemplo mais próximo, com normalização de escala, correção de proporção, reflexão da mão e tolerância angular.

Esse método atual é uma linha de base funcional. Ele não deve ser interpretado como a arquitetura ideal para um produto de reconhecimento de LIBRAS.

## 1. Escopo linguístico e pedagógico

### Dificuldade

O projeto trata principalmente o alfabeto manual e numerais como “LIBRAS”, mas LIBRAS é uma língua completa. Sinais dependem de configuração de mão, orientação, ponto de articulação, movimento, expressões não manuais e contexto. Soletração manual é apenas uma parte do idioma.

Também existem variações regionais, pessoais e pedagógicas. Uma referência visual isolada pode não representar todas as formas aceitáveis de um sinal.

### Riscos

- Rejeitar uma execução linguisticamente correta porque ela difere da referência usada no dataset.
- Aprovar uma pose parecida geometricamente, mas incorreta segundo a LIBRAS.
- Ensinar ao iniciante um padrão inadequado.
- Comunicar “reconhecimento de LIBRAS” quando o sistema avalia apenas um subconjunto do alfabeto manual.
- Usar tempo de conclusão como principal recompensa e incentivar velocidade antes da execução correta.

### Evidência necessária

- Revisão das referências e dos critérios de aprovação por instrutor ou pesquisador de LIBRAS.
- Lista explícita dos sinais aceitos, suas variações e quais atributos distinguem cada par confundível.
- Definição pedagógica da ordem de ensino e do feedback mostrado quando o aluno erra.
- Testes de usabilidade com iniciantes e pessoas sinalizantes.

### Decisão associada

Definir se o piloto será apresentado como:

- treino do alfabeto manual;
- treino de datilologia;
- introdução mais ampla à LIBRAS;
- ou demonstração técnica de reconhecimento de poses.

Essa decisão altera conteúdo, métricas, linguagem da interface e requisitos do modelo.

## 2. Quantidade, diversidade e qualidade do dataset

### Estado atual

| Aspecto | Situação atual |
| --- | --- |
| Registros no CSV | 137 |
| Letras com apenas uma amostra | 20 |
| Numerais | nenhum |
| Identificação de participante | inexistente |
| Identificação de sessão/câmera | inexistente |
| Mão dominante/lateralidade | não registrada no dataset |
| Qualidade do rótulo | não auditada linguisticamente |
| Sequências dinâmicas | frames de poucos vídeos |
| Conjunto de teste independente | inexistente |

### Dificuldade

Uma amostra por classe funciona como referência, mas não descreve a distribuição real daquele sinal. O modelo não aprende variações de mão, rotação, distância, iluminação, oclusão, lateralidade ou execução.

Frames consecutivos do mesmo vídeo são altamente correlacionados. Contá-los como amostras independentes dá uma impressão exagerada de volume.

### Riscos

- Memorizar uma pessoa, fundo ou ângulo específico.
- Resultados aparentemente bons no dataset e ruins na webcam de outra pessoa.
- Classes com mais frames dominarem o treinamento.
- Não conseguir medir se uma mudança de modelo realmente melhorou o sistema.
- Personalização mascarar um problema do modelo geral.

### O que precisa ser coletado

Cada captura deveria incluir, no mínimo:

- identificador pseudônimo do participante;
- sinal executado;
- mão direita ou esquerda;
- sessão e dispositivo;
- resolução e orientação da câmera;
- sequência completa de landmarks;
- recorte da mão, se houver consentimento para esse tipo de dado;
- instante de início e fim para sinais dinâmicos;
- revisão do rótulo;
- indicação de amostra válida, ambígua ou descartada.

### Ordem de grandeza inicial

Para um estudo piloto mais sério, uma meta razoável é coletar 20 a 30 participantes e pelo menos 30 repetições por sinal por participante. Isso não garante qualidade de produto, mas permite começar a medir generalização e confusões. Sinais dinâmicos exigem sequências completas, não frames rotulados individualmente.

### Decisão associada

Decidir se o projeto investirá primeiro em coleta própria, parceria com uma instituição, uso de dataset público compatível ou combinação dessas fontes. A compatibilidade linguística e do formato de landmarks precisa ser verificada antes de misturar bases.

## 3. Ausência de avaliação independente

### Dificuldade

Os resultados atuais verificam integração, não acurácia real. O navegador reconheceu 17 de 20 fotos estáticas do próprio acervo acima do limiar; três imagens nem produziram landmarks. Essa medição reutiliza o material de referência e, portanto, não mostra desempenho com pessoas novas.

Os testes automatizados validam regras de software — temporização, persistência, normalização e rejeição de entradas — mas não validam se uma pessoa realizou corretamente um sinal de LIBRAS.

### Riscos

- Confundir “testes passaram” com “modelo reconhece sinais corretamente”.
- Otimizar hiperparâmetros olhando para o mesmo conjunto usado como referência.
- Escolher um modelo com boa média geral, mas muito ruim justamente nos pares mais importantes.

### Protocolo recomendado

Separar dados por participante:

```text
participantes de treino       → ajuste do modelo
participantes de validação    → limiar e hiperparâmetros
participantes de teste        → resultado final, usado uma única vez
```

Nunca se deve colocar frames da mesma pessoa ou do mesmo vídeo em treino e teste.

### Métricas necessárias

- precisão, revocação e F1 por sinal;
- matriz de confusão;
- taxa de falso positivo por minuto;
- taxa de falso negativo;
- tempo até confirmação;
- percentual de sessões em que o MediaPipe não encontra a mão;
- desempenho por participante, dispositivo, iluminação e lateralidade;
- desempenho específico nos pares confundíveis, como R/U e M/N/T;
- taxa de conclusão dos minigames sem calibração pessoal;
- estabilidade do escore durante um sinal mantido.

### Decisão associada

Definir critérios de aceite antes de treinar o próximo modelo. Exemplo: nenhum sinal crítico abaixo de determinado F1, falso positivo abaixo de um limite e diferença controlada entre grupos de participantes.

## 4. Oclusão e limitações do MediaPipe

### Dificuldade

MediaPipe Hands estima 21 pontos. Quando dedos ficam atrás de outros, parte desses pontos não é observável e precisa ser inferida. A coordenada `z` é relativa ao pulso e não equivale à profundidade medida por um sensor 3D.

O espelhamento melhora a experiência visual, mas exige consistência entre vídeo, lateralidade, treinamento e matemática. Fotos em formato vertical e webcam horizontal também produzem coordenadas normalizadas em escalas diferentes; o projeto já corrige a proporção, mas essa correção não resolve oclusão.

### Casos difíceis

- R versus U: cruzamento e relação entre os dedos podem desaparecer nos landmarks.
- M, N e T: pequenas diferenças de posição do polegar entre dedos dobrados.
- punho fechado: pontas dos dedos podem ser estimadas de forma instável.
- mão parcialmente fora do quadro.
- câmera com borrão de movimento ou baixa resolução.
- pele e fundo com pouco contraste.
- rotação da palma que altera quais dedos estão visíveis.

### Riscos

- O classificador receber uma geometria errada com aparência de alta confiança.
- Oscilação entre classes em frames consecutivos.
- Impossibilidade de separar classes mesmo com um modelo mais sofisticado sobre os mesmos landmarks.

### Opções de engenharia

| Opção | Benefício | Custo/limitação |
| --- | --- | --- |
| Somente landmarks | rápido, leve e privado | perde textura e sinais de sobreposição |
| Recorte RGB da mão | enxerga cruzamentos e aparência | exige dataset de imagens e mais processamento |
| Landmarks + RGB | combina geometria e informação visual | arquitetura e treinamento mais complexos |
| Duas câmeras/sensor de profundidade | reduz ambiguidade 3D | inviável para a maioria dos usuários web |
| Pedir outro ângulo | solução simples para casos incertos | piora fluidez e experiência pedagógica |

### Decisão associada

Executar um experimento controlado comparando landmarks, imagem e modelo híbrido nos pares confundíveis. Se um par não for separável pelos landmarks, insistir no classificador de landmarks apenas deslocará o problema.

## 5. Classificador estático atual

### Dificuldade

O classificador atual escolhe o exemplo mais próximo por classe. Ele aplica normalização de posição e tamanho, correção de proporção, reflexão e pequenas rotações. Esse método é interpretável e adequado como linha de base, mas possui limites:

- depende fortemente de exemplos representativos;
- não aprende automaticamente quais articulações distinguem cada par de classes;
- usa limiares escolhidos manualmente;
- o escore de semelhança não é uma probabilidade calibrada;
- pode aceitar uma classe distante se ela ainda for a menos distante;
- exemplos pessoais podem melhorar um perfil e piorar outro se forem rotulados incorretamente.

### Alternativas a comparar

| Modelo | Quando faz sentido | Observação |
| --- | --- | --- |
| k-NN/protótipos | baseline e personalização local | custo cresce com exemplos e separação é simples |
| Random Forest | baseline tabular pequeno | não resolve falta de dados nem oclusão |
| SVM | fronteiras fortes em dataset moderado | exige ajuste e probabilidade calibrada à parte |
| MLP sobre landmarks | bom candidato para poses estáticas | precisa de mais participantes e regularização |
| CNN no recorte da mão | sinais dependentes de aparência/oclusão | mais dados, memória e custo computacional |
| Modelo híbrido | classes difíceis e maior robustez | maior complexidade de treino e inferência |

### Decisão associada

Não escolher um modelo por preferência tecnológica. Comparar alternativas no mesmo protocolo, com a mesma divisão por participante, as mesmas classes e métricas por sinal.

## 6. Sinais dinâmicos e segmentação temporal

### Dificuldade

H, J, K, X e Z usam segmentação de trajetória e comparação com exemplos pessoais por Dynamic Time Warping (DTW). Heurísticas geométricas delimitam o começo e o fim do movimento; a classe prevista depende da sequência completa. Depois, a engine exige confirmação contínua da pose terminal por um segundo. Os limiares foram testados sobretudo com trajetórias sintéticas, não calibrados em um conjunto representativo de usuários.

Além de classificar o movimento, o sistema precisa descobrir quando ele começou e terminou. Velocidade, amplitude, direção, mão utilizada e FPS variam.

### Riscos

- Movimento correto executado fora da velocidade esperada ser rejeitado.
- Movimento casual formar a trajetória esperada e gerar falso positivo.
- Quedas de FPS apagarem o buffer temporal.
- A exigência de manter a pose final não corresponder ao comportamento natural do sinal.

### Caminhos de evolução

- coletar sequências completas com marcação de início e fim;
- normalizar trajetória por escala, duração e orientação;
- validar e ajustar o baseline temporal por DTW com gravações independentes;
- comparar TCN, LSTM/GRU ou Transformer pequeno;
- adicionar uma classe “nenhum sinal/transição”;
- avaliar streaming contínuo, não apenas clipes previamente segmentados.

### Decisão associada

Definir se o piloto continuará com poucos sinais dinâmicos e heurísticas auditáveis ou se assumirá o custo de um modelo temporal generalizável.

## 7. Confiança, rejeição e máquina de estados

### Dificuldade

O requisito de mais de 85% por 1000 ms reduz falsos positivos isolados, mas depende de o escore significar algo consistente. Hoje, o classificador estático produz semelhança geométrica; o motor dinâmico produz semelhança entre sequências por DTW, combinada com a separação entre classes. Nenhum desses escores é uma probabilidade calibrada de acerto.

O limite atual de 180 ms entre observações exige aproximadamente 6 FPS ou mais. Dispositivos lentos podem reiniciar a confirmação mesmo quando o usuário mantém o sinal corretamente.

### Riscos

- Um limiar global ser permissivo para algumas letras e impossível para outras.
- Dispositivos rápidos e lentos oferecerem dificuldades diferentes.
- Confiança alta ser interpretada pelo usuário como certeza científica.
- Aguardar um segundo aumentar precisão, mas tornar a interação cansativa em sequências longas.

### Melhorias a estudar

- calibração por classe;
- rejeição por distância absoluta e margem para a segunda classe;
- suavização temporal sem acumular poses descontínuas;
- limiar baseado na distribuição do conjunto de validação;
- janela adaptativa ao FPS, com duração real medida por relógio monotônico;
- mensagens diferentes para “mão ausente”, “classe errada”, “ambíguo” e “quase correto”.

### Decisão associada

Definir separadamente o limiar de classificação, a política de rejeição e a duração pedagógica de confirmação. Um único número não deve representar três decisões diferentes.

## 8. Personalização local

### Estado atual

O usuário pode salvar cinco observações por captura, até 12 exemplos por sinal e por perfil. Apenas coordenadas normalizadas são persistidas no `localStorage`; nenhuma foto é salva.

### Benefícios

- adapta-se à mão, câmera e maneira de executar daquele usuário;
- permite criar exemplos de numerais ausentes do dataset;
- mantém privacidade e funcionamento client-side.

### Dificuldades e riscos

- o usuário pode ensinar uma pose errada;
- o sistema não distingue calibração ruim de variação válida;
- os exemplos ficam presos ao navegador e à origem usada (`file://`, porta e domínio podem ter armazenamentos diferentes);
- não há sincronização, exportação ou recuperação;
- `localStorage` tem quota limitada e não oferece transações;
- personalização dificulta comparar desempenho geral entre usuários;
- capturar numerais sem uma referência validada transforma o produto em um classificador supervisionado pelo próprio iniciante.

### Decisão associada

Definir o papel da personalização:

- correção temporária para o dataset pequeno;
- recurso permanente de acessibilidade;
- ou ferramenta interna de coleta.

Cada papel exige UX, governança e métricas diferentes.

## 9. Números ainda não possuem base de reconhecimento

### Dificuldade

Os modos de números existem, mas o dataset original não contém numerais. Atualmente, o usuário precisa criar exemplos pessoais de 0 a 9.

### Risco

O dashboard comunica seis jogos prontos, mas dois deles dependem de uma etapa de treinamento manual. Isso pode frustrar o iniciante e comprometer a coerência pedagógica.

### Decisões possíveis

1. coletar e validar um dataset de numerais antes de manter esses jogos disponíveis;
2. marcar os modos como experimentais e oferecer um tutorial de calibração;
3. retirar temporariamente os numerais do piloto público;
4. incluir um modelo/base licenciada e validada para numerais.

## 10. Privacidade, biometria e governança dos dados

### Dificuldade

O processamento da webcam ocorre localmente, o que reduz exposição. Ainda assim, imagens de mãos, vídeos e padrões de movimento podem ser considerados dados pessoais ou sensíveis dependendo do contexto, finalidade e legislação aplicável.

Uma futura coleta centralizada mudará substancialmente o risco do produto.

### Questões em aberto

- Qual é a base legal e o consentimento para coletar imagens/vídeos?
- Participantes podem solicitar exclusão?
- Como separar identidade de dados de treinamento?
- Por quanto tempo guardar os dados?
- Quem pode acessar e rotular as gravações?
- É permitido treinar e redistribuir o modelo com aquele material?
- Como tratar dados de menores de idade?
- Como documentar origem e licença de datasets externos?

### Decisão associada

Antes de criar backend ou coletor central, elaborar política de dados, consentimento, retenção, anonimização/pseudonimização, controle de acesso e rastreabilidade de versões do dataset.

## 11. Restrições do processamento 100% client-side

### Benefícios

- baixa latência após o carregamento;
- câmera não precisa ser enviada ao servidor;
- menor custo operacional;
- possibilidade de funcionamento parcialmente offline.

### Dificuldades

- grande variação de CPU, GPU, memória, câmera e navegador;
- primeira ativação depende hoje da CDN do MediaPipe;
- modelos maiores aumentam tempo de download e memória;
- aquecimento do dispositivo e consumo de bateria;
- throttling quando a aba perde foco;
- permissões de câmera são mais previsíveis em HTTPS ou localhost do que em `file://`;
- depuração é mais difícil sem telemetria;
- atualização de modelo exige distribuir novos assets.

### Métricas de performance necessárias

- tempo até câmera pronta;
- tamanho total de download;
- FPS de captura e de inferência;
- latência por frame p50/p95;
- uso aproximado de memória;
- frames descartados;
- consumo em dispositivos de entrada;
- tempo de bateria em uma sessão típica.

### Decisão associada

Definir orçamento técnico do modelo: tamanho máximo, latência, FPS mínimo e dispositivos suportados. Isso restringe a escolha entre MLP, CNN e modelos híbridos.

## 12. Dependências, offline e implantação

### Dificuldade

Embora o aplicativo não tenha dependências npm instaladas, ele carrega MediaPipe por CDN. Abrir o HTML diretamente possui diferenças de câmera, módulos, cache e persistência entre navegadores. O bundle para `file://` precisa ser regenerado após alterações nos módulos.

### Riscos

- funcionamento variar entre Live Server e arquivo aberto diretamente;
- indisponibilidade ou mudança externa da CDN;
- versão do bundle ficar desatualizada em relação aos módulos;
- ausência de cabeçalhos de segurança e política de conteúdo;
- cache manter versões incompatíveis do modelo e do código.

### Decisão associada

Para um piloto distribuído, preferir hospedagem HTTPS estática, fixar e eventualmente hospedar localmente os assets do MediaPipe, definir versionamento/cache e automatizar a geração do bundle em CI.

## 13. Produto, gamificação e interpretação do score

### Dificuldade

O menor tempo é tratado como melhor resultado. Entretanto, o tempo inclui:

- capacidade do usuário;
- velocidade do dispositivo;
- FPS de inferência;
- dificuldade da sequência aleatória;
- tempo de recuperação após falha de rastreamento;
- eventual calibração do perfil.

Portanto, recordes de dispositivos, sequências e versões diferentes não são diretamente comparáveis.

### Riscos

- recompensar movimentos rápidos e imprecisos;
- punir usuários com limitações motoras ou dispositivos lentos;
- criar falsa sensação de ranking pedagógico;
- comparar rodadas aleatórias de dificuldade desigual.

### Melhorias a estudar

- registrar precisão/estabilidade separadamente do tempo;
- não comparar sequências aleatórias diferentes como se fossem equivalentes;
- oferecer modo sem cronômetro;
- medir domínio por repetição espaçada e evolução, não só velocidade;
- evitar ranking competitivo até controlar hardware e dificuldade;
- separar versão do modelo nos recordes para invalidar comparações antigas quando necessário.

### Decisão associada

Definir qual comportamento a gamificação deve incentivar: velocidade, consistência, retenção, frequência de prática ou progresso pedagógico.

## 14. Acessibilidade e inclusão

### Dificuldade

O público pretendido é iniciante e inclusivo, mas a câmera e a confirmação por pose podem excluir usuários com diferenças motoras, ausência de dedos, tremor, amplitude reduzida ou impossibilidade de sustentar a mão por um segundo.

### Pontos a avaliar

- modo sem cronômetro;
- duração de confirmação configurável;
- tolerância calibrada ao usuário;
- instruções visuais e textuais, sem depender somente de cor;
- referências em vídeo com controles e legendas;
- navegação completa por teclado e leitor de tela;
- contraste, zoom e redução de movimento;
- alternativa ao uso da câmera;
- mensagens que não culpem o aluno por falhas do rastreador.

### Decisão associada

Definir quais necessidades de acessibilidade o piloto pretende suportar e envolver esses usuários nos testes desde o início, não apenas no final.

## 15. Observabilidade e depuração

### Dificuldade

Por não haver backend, o time não sabe automaticamente:

- quais classes mais falham;
- em quais dispositivos o FPS é insuficiente;
- quando MediaPipe perde a mão;
- qual é a matriz de confusão real;
- se a calibração pessoal ajuda;
- em que etapa usuários abandonam o jogo.

### Opções

- painel local de diagnóstico exportável pelo usuário;
- gravação local opcional de métricas sem imagem;
- sessões de teste supervisionadas;
- telemetria opt-in, agregada e com política explícita;
- exportação manual de landmarks anonimizados para pesquisa, mediante consentimento.

### Decisão associada

Equilibrar privacidade e capacidade de aprender com o piloto. Sem alguma forma de observação, decisões serão guiadas por relatos isolados.

## 16. Manutenibilidade e dívida técnica

### Pontos atuais

- Há dois pipelines históricos: Python/Random Forest e navegador/classificador por exemplos.
- O README ainda preserva instruções do protótipo Python, o que pode confundir a arquitetura vigente.
- `js/dataset.js` é gerado e grande; mudanças no CSV exigem executar o exportador.
- O bundle de abertura direta também é gerado manualmente.
- As heurísticas possuem constantes fixas que ainda não foram estimadas de dados reais.
- Não existe CI configurada para garantir testes e regeneração dos artefatos.
- Não existe registro formal da versão do modelo/heurísticas associado a cada score.

### Riscos

- alterar a fonte sem atualizar o arquivo gerado;
- comparar resultados de versões diferentes;
- manter dois caminhos de execução com comportamentos divergentes;
- acumular regras especiais por letra sem teste de campo.

### Decisão associada

Definir qual pipeline será oficial, automatizar exportação/build/testes e tratar dados/modelos como artefatos versionados com metadados reproduzíveis.

## 17. Testes que existem e testes que faltam

### Já coberto

- confirmação somente depois de 1000 ms;
- queda de confiança e perda de tracking;
- frames atrasados e lacunas;
- sequências dos minigames;
- isolamento de perfis e recordes;
- normalização, escala, reflexão, proporção e algum ruído sintético;
- rejeição de entradas inválidas e ambíguas;
- trajetórias sintéticas de H, J, K, X e Z;
- persistência de exemplos pessoais;
- reprocessamento diagnóstico de referências estáticas.

### Ainda necessário

- teste com participantes não presentes no dataset;
- teste de todas as letras com webcam ao vivo;
- teste de numerais com base validada;
- matriz de confusão por pessoa;
- teste de lateralidade real;
- teste em celulares e notebooks de desempenho baixo;
- teste com iluminação, fundos e resoluções diferentes;
- teste de H/J/K/X/Z realizados naturalmente;
- avaliação por especialista em LIBRAS;
- estudo de usabilidade com iniciantes;
- acessibilidade com diferentes capacidades motoras;
- teste offline e de falha da CDN;
- teste de upgrade/migração entre versões de dataset e modelo.

## Priorização sugerida

### P0 — antes de afirmar que o sistema reconhece LIBRAS

1. Delimitar o escopo linguístico e revisar referências com especialista.
2. Criar protocolo de coleta com consentimento e metadados.
3. Coletar participantes suficientes e separar treino/validação/teste por pessoa.
4. Criar avaliação reproduzível e matriz de confusão.
5. Tratar explicitamente pares confundíveis e a classe “nenhum sinal”.

### P1 — para decidir a arquitetura do modelo

1. Manter o classificador atual como baseline.
2. Treinar Random Forest/SVM/MLP com os mesmos dados e a mesma divisão.
3. Avaliar um classificador de recorte RGB nos pares com oclusão.
4. Avaliar fusão de imagem e landmarks.
5. Validar o baseline temporal já implementado para H/J/K/X/Z com gravações de pessoas e sessões separadas.
6. Calibrar escores e limiares por classe.

### P2 — para transformar piloto em produto testável

1. Hospedar estaticamente em HTTPS e fixar assets.
2. Criar diagnóstico local exportável.
3. Melhorar feedback pedagógico e acessibilidade.
4. Versionar modelo, dataset, heurísticas e recordes.
5. Automatizar testes e geração dos artefatos.

### P3 — para escala futura

1. Definir governança de dados e estratégia de atualização de modelo.
2. Avaliar sincronização de perfis sem comprometer privacidade.
3. Planejar monitoramento opt-in.
4. Expandir além do alfabeto com conteúdo linguisticamente validado.

## Matriz de decisões

| Decisão | Evidência necessária | Evitar decidir com base em |
| --- | --- | --- |
| Random Forest, MLP ou CNN | teste por participante e por classe | acurácia no próprio treino |
| Manter somente landmarks | separabilidade de pares com oclusão | conveniência de implementação |
| Limiar de 85% | curvas de falso positivo/negativo | número arbitrário ou escore não calibrado |
| Um segundo de confirmação | teste de UX e estabilidade | somente redução de falsos positivos |
| Manter jogos de números | dataset validado ou fluxo pedagógico de calibração | exemplos criados por iniciantes sem referência |
| Ranking por tempo | controle de hardware e dificuldade | tempos brutos de rodadas diferentes |
| Coletar imagens | política, consentimento e necessidade comprovada | armazenar “para usar depois” |
| Adicionar backend | requisitos de sincronização/coleta/telemetria | adoção tecnológica sem finalidade clara |

## Experimentos recomendados

### Experimento A — R versus U

Objetivo: descobrir se os landmarks contêm informação suficiente.

1. Coletar R e U de pelo menos 20 pessoas, com 30 repetições cada.
2. Separar participantes de treino e teste.
3. Comparar k-NN, Random Forest, SVM e MLP sobre os mesmos landmarks.
4. Treinar uma CNN pequena somente nos recortes RGB.
5. Comparar com fusão RGB + landmarks.
6. Inspecionar erros por rotação e oclusão.

Se todos os modelos de landmarks falharem e a imagem funcionar, o gargalo é a representação, não o classificador.

### Experimento B — valor da personalização

Objetivo: medir se exemplos locais resolvem variação individual.

1. Medir o usuário sem exemplos pessoais.
2. Adicionar 1, 2 e 3 capturas por sinal.
3. Medir novamente em sessão e iluminação diferentes.
4. Comparar melhora, regressão e retenção após alguns dias.

### Experimento C — confirmação temporal

Objetivo: equilibrar falsos positivos e fluidez.

Comparar 300, 500, 750 e 1000 ms, medindo falso positivo, tempo de conclusão, fadiga e percepção do usuário. O classificador deve ser o mesmo durante a comparação.

### Experimento D — desempenho no navegador

Objetivo: definir o orçamento do futuro modelo.

Executar o pipeline em um celular de entrada, celular intermediário e notebook sem GPU dedicada. Medir carregamento, FPS, latência, memória e aquecimento para modelos de landmarks, imagem e híbrido.

## Assuntos para estudo

### LIBRAS e desenho pedagógico

- parâmetros fonológicos da LIBRAS;
- datilologia e variação regional;
- avaliação por especialistas e concordância entre avaliadores;
- ensino para iniciantes e repetição espaçada;
- desenho inclusivo e feedback de aprendizagem.

### Visão computacional

- oclusão e estimativa de pose de mão;
- normalização de landmarks;
- classificação open-set e classe de rejeição;
- fusão multimodal de landmarks e RGB;
- reconhecimento temporal e segmentação de gestos;
- calibração de probabilidade;
- domain shift entre pessoas e dispositivos.

### Machine Learning e avaliação

- divisão por grupos/participantes;
- matriz de confusão e métricas por classe;
- desbalanceamento de classes;
- aumento de dados plausível;
- leakage entre treino e teste;
- análise de erros e hard-negative mining;
- fairness e desempenho por subgrupo;
- quantização e inferência TensorFlow.js/ONNX no navegador.

### Engenharia de produto

- privacidade desde o desenho;
- versionamento e lineage de datasets/modelos;
- observabilidade local e telemetria opt-in;
- orçamento de performance web;
- acessibilidade em experiências baseadas em câmera;
- desenho de experimentos e critérios de aceite.

## Perguntas para a próxima reunião técnica

1. Qual é exatamente a promessa educacional da primeira versão?
2. Quem validará linguisticamente cada referência e variação aceita?
3. Podemos coletar dados de participantes? Sob qual protocolo e consentimento?
4. Quais dispositivos precisam ser suportados?
5. Quais classes são obrigatórias no piloto e quais podem ficar experimentais?
6. Qual custo de falso positivo é aceitável comparado ao falso negativo?
7. Números devem permanecer antes de existir uma base validada?
8. A personalização é um recurso final ou uma ponte até termos dados melhores?
9. Podemos usar imagens da mão ou a exigência será somente landmarks?
10. Quais métricas determinarão que o piloto está pronto para usuários externos?

## Critério de saída da fase de pesquisa

Uma possível definição de pronto para evoluir do protótipo técnico para um piloto externo é:

- conteúdo revisado por especialista em LIBRAS;
- dataset documentado e licenciado;
- teste separado por participante;
- métricas por classe e matriz de confusão publicadas internamente;
- pares críticos dentro dos critérios acordados;
- política clara de rejeição de sinais desconhecidos;
- desempenho aceitável nos dispositivos alvo;
- fluxo acessível e testado com iniciantes;
- privacidade, consentimento e retenção definidos;
- modelo e dataset versionados de forma reproduzível.

Até esses pontos serem atendidos, o projeto deve ser tratado como **piloto experimental de ensino e reconhecimento**, não como avaliador confiável de execução em LIBRAS.
