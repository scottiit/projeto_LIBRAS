# Referências visuais de LIBRAS

A interface utiliza os 27 arquivos PNG (A–Z e Ç), recortados diretamente de
`Gemini_Generated_Image_1vg02g1vg02g1vg0.jpg`, fornecida pelo usuário.
Cada cartão mede 390 × 290 pixels e preserva a imagem original, incluindo
letra e indicação de movimento. Não houve ampliação, redesenho ou vetorização.
A prancha enviada contém a marca Toda Matéria; não atribuímos autoria ao projeto.
As poses devem ser conferidas com um instrutor de LIBRAS.

## Regeneração

`python scripts/extract-reference-cards.py caminho/Gemini_Generated_Image_1vg02g1vg02g1vg0.jpg`

Requer Pillow e a fonte de 1728 × 2442 pixels apenas para gerar os recortes.
Os SVGs anteriores são legados e não são carregados pela interface.
As fotos usadas pelo classificador e os vídeos de movimento não foram alterados.

## Números

Os arquivos `number-0.png` a `number-9.png` são recortes da prancha
`Números em Libras_ sinal do sete.png` fornecida pelo usuário, com a marca
Toda Matéria. Cada cartão mede 492 × 246 pixels, sem ampliação ou redesenho.

Para regenerar, usando a fonte de 1083 × 1452 pixels:

`python scripts/extract-number-reference-cards.py "caminho/Números em Libras_ sinal do sete.png"`
