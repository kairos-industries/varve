# Search by meaning with a static embedding model

Keyword search missed notes worded differently from the question: "typefaces slowing down the first launch" did not find the note about fonts loading on cold start. With matches by meaning fused in, that note ranks first. Search now also matches by meaning, using potion-base-8M, a model2vec static embedding model (MIT). A static model is a lookup table: a text's vector is the mean of its tokens' vectors. So the encoder is a WordPiece tokenizer and a loop over a 29,528 x 256 matrix, about 150 lines of TypeScript, with no native code and no runtime dependency. It works the same on macOS, Linux and Windows, and embeds a note in microseconds.

The model is not in the repository or the package. `models pull` downloads it once from a pinned revision and checks its SHA-256 hashes, and `setup` asks first. The server never downloads anything, so with no model installed search is keyword only and the atlas stays fully offline.

## Considered options

- Transformer embeddings through transformers.js or onnxruntime (for example all-MiniLM-L6-v2): better on paraphrases, but they add a native runtime of over 100 MB per platform to a tool that has four small dependencies, and are slower per note.
- An embeddings API: better models, but it sends note text to a third party, against the rule that the atlas stays on the user's disk.
- Keyword search only, with synonyms: no model, but a synonym list never covers how people phrase things.
