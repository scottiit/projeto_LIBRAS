# Reconhecimento de LIBRAS

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
