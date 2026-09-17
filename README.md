# Primeiros Sinais — piloto web de LIBRAS

Aplicação client-side em HTML, CSS e JavaScript Vanilla, com seis minigames, perfis locais, cronômetro e confirmação contínua de 1 segundo.

## Abrir o piloto

Abra **`index.html`** diretamente no navegador ou use **Open with Live Server** no VS Code. A versão direta já inclui o bundle necessário; não é preciso instalar pacotes. Para câmera e persistência previsíveis, prefira Live Server em localhost.

Alternativa com Node.js: execute `node scripts/serve.js` e acesse `http://127.0.0.1:5173`. Esse comando só serve arquivos estáticos, sem backend da aplicação.

1. Crie ou selecione um perfil.
2. Escolha um dos seis jogos. **A câmera é o modo padrão**, inclusive para perfis antigos após a atualização.
3. Clique em **Ativar câmera**. Na primeira ativação da sessão, aguarde a extração dos exemplos das fotos locais pelo mesmo MediaPipe usado na webcam.
4. Faça um sinal: **Detectado: A**, por exemplo, mostra a classe efetivamente identificada, mesmo antes da partida. Clique em **Iniciar partida** para pontuar; são necessários mais de 85% por 1 segundo ininterrupto.
5. Se estiver incerto, abra **Ver referência e ajustar à minha mão**, escolha o sinal, reproduza a referência e clique em **Salvar exemplos deste sinal**. Há 2 segundos para se posicionar e 1,2 segundo de captura estável. Os exemplos ficam apenas no perfil local. A captura aprende a pose mostrada; ela não verifica se o exemplo ensinado está correto.
6. Não há numerais no dataset original. Antes de iniciar jogos de números, capture exemplos dos números da sequência usando o seletor. J, Z e X continuam sendo avaliados por movimento e não admitem calibração estática.

Para testar somente a engine, habilite **Simular acertos (debug)** no dashboard e segure **Espaço** ou o botão de simulação. **Enter** no botão alterna a injeção contínua, e **Injetar queda para 84%** testa a interrupção. Recordes de demonstração continuam separados.

**Estado do reconhecimento:** o classificador real compara landmarks normalizados com exemplos rotulados de **23 letras**, sem receber a letra alvo. Há correção de escala, proporção da imagem e espelhamento; poses ambíguas ou distantes não passam no limiar. O escore é uma medida de semelhança, **não uma probabilidade calibrada de acerto**. J, Z e X usam heurísticas experimentais. O dataset original tem apenas uma amostra para muitas letras: pode ser necessário salvar exemplos pessoais. A câmera depende de permissão e do carregamento de recursos pela CDN; nenhum frame é enviado a um servidor.

## Desenvolvimento e testes

```text
node --test
node scripts/export-dataset.js
node scripts/build.js
```

Edite os módulos em `js/` e execute `node scripts/build.js` após alterações para atualizar `js/app.bundle.js`, usado somente em `file://`. O exportador recria `js/dataset.js` a partir do CSV e da proporção das mídias originais; execute-o se esses dados mudarem. Mantenha a pasta de imagens/vídeos junto ao app para a extração de exemplos no navegador. Via HTTP os módulos são carregados diretamente. Sem dependências de instalação.

O diagnóstico `tests/reference-check.html`, acessível pelo servidor local, executa a preparação de exemplos e reprocessa as fotos originais com MediaPipe JavaScript. É um teste de integração sobre o próprio acervo, **não** validação independente de acurácia.

Consulte [a auditoria e decisões técnicas](docs/AUDIT.md) para os problemas do protótipo, arquitetura, funcionamento do limiar e limitações de visão. Os arquivos Python e o material científico abaixo foram preservados, sem participação no runtime web.

Para planejar os próximos ciclos, consulte também [dificuldades atuais e decisões de engenharia](docs/DIFFICULDADES_ATUAIS.md). O documento relaciona limitações, riscos, evidências necessárias, experimentos e critérios para escolher a futura arquitetura de reconhecimento.

---

# Protótipo científico original — Reconhecimento de LIBRAS

Projeto acadêmico de reconhecimento de sinais de LIBRAS utilizando **visão computacional**, **MediaPipe** e **Machine Learning**.

Nesta etapa, o sistema utiliza a webcam para detectar a mão, extrair seus pontos (*landmarks*) e reconhecer sinais previamente treinados do alfabeto manual.

> O projeto ainda está em desenvolvimento e seu escopo poderá ser ampliado posteriormente.

## Tecnologias

- Python
- OpenCV
- MediaPipe
- NumPy
- Pandas
- Scikit-learn
- Joblib

## Estrutura principal

```text
projeto_LIBRAS/
├── Libras.py
├── treinar.py
├── webcam.py
├── dataset_libras.csv
├── modelo_libras.pkl
├── hand_landmarker.task
└── requirements.txt
```

## Como executar

### 1. Clone o repositório

```bash
git clone https://github.com/isbllvt/projeto_LIBRAS.git
cd projeto_LIBRAS
```

### 2. Crie um ambiente virtual

```bash
python -m venv .venv
```

No Windows, no Prompt de Comando (cmd):

```bat
.venv\Scripts\activate.bat
```

Se você preferir usar o PowerShell, execute antes:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

Depois, ative com:

```powershell
.venv\Scripts\Activate.ps1
```

### 3. Instale as dependências

```bash
pip install -r requirements.txt
```

### 4. Execute o reconhecimento

Com o modelo já disponível no projeto:

```bash
python webcam.py
```

A webcam será utilizada para realizar o reconhecimento em tempo real.

## Treinamento

Para gerar os dados:

```bash
python Libras.py
```

Depois, para treinar o modelo:

```bash
python treinar.py
```

O modelo treinado será salvo para ser utilizado pelo `webcam.py`.

## Observações

O projeto está em fase de desenvolvimento. Atualmente, o foco é o reconhecimento de sinais estáticos, não sendo uma tradução completa de LIBRAS para português.

## Autores

**Fernanda Brito Saraiva**

**Franciéllen Sousa Araújo**

**Isabelle Vitória Santiago Mendonça**

**Joanna Marieli Trindade do Nascimento**

**Tatyana Franciele Brasil Machado**

Projeto desenvolvido no contexto acadêmico da **Universidade Federal do Oeste do Pará (UFOPA)**.
