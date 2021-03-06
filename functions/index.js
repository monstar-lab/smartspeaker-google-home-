const functions = require('firebase-functions');
// const { DialogflowApp } = require('actions-on-google');
const { ActionsSdkApp } = require('actions-on-google');
const kuromoji = require('kuromoji');
const admin = require("firebase-admin");
admin.initializeApp(functions.config().firebase);
const db = admin.database();
const kuromojiBuilder = kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict/' });

const getRandomInt = (max) => {
  return Math.floor(Math.random() * Math.floor(max));
};

exports.shiritoriResponse = functions.https.onRequest((request, response) => {
  console.log(request.body.inputs);
  const app = new ActionsSdkApp({request: request, response: response});

  const usedWordRef = db.ref('/shiritori/usedWord');
  const dictionaryPath = '/shiritori/dictionary/';
  const timerRef = db.ref('/shiritori/timer');

  function welcomeIntent (app) {
    startCharObject = db.ref('/shiritori/dictionary').on('value', (snap) => {
      wordList = snap.val()
      startCharList = [];
      for (char in wordList) {startCharList.push(char)}
      var speakerLastWord = startCharList[getRandomInt(startCharList.length)];
      // var speakerLastWord = 'か';
      console.log(speakerLastWord);
      usedWordRef.set({
        lastWord: speakerLastWord,
        usedWords: [speakerLastWord]
      });
      timerRef.set({
        msg: "start"
      });
      const inputPrompt = app.buildInputPrompt(true,`<speak>しりとりをしましょう。「${speakerLastWord.slice(-1)}ー」から始めてください。</speak>`,
        ['<speak><break time="10s"/></speak>','.','<speak>時間オーバーです。わたしの勝ちです。</speak>']);
      // app.ask(`しりとりをしましょう。「${speakerLastWord.slice(-1)}」から始めてください。制限時間は20秒です。`);
      app.ask(inputPrompt);
    });
  }

  function kuromojiPromise (input) {
    return new Promise((resolve, reject) => {
      kuromojiBuilder.build((err, tokenizer) => {
        if (err) {console.log(err)}
        console.log(input);
        kanaList = [];
        path = tokenizer.tokenize(input);
        for (i = 0; i < path.length; i++) {
          kanaList.push(path[i]['reading']);
        }
        convertedInput = path[0]['reading'] ? kanaToHira(kanaList.join('')) : kanaToHira(input);
        resolve(convertedInput);
      })
    })
  }

  const readDB = (input) => {
    return new Promise((resolve, reject) => {
      usedWordRef.once('value', (snap) => {
        resolve({input: input, data: snap.val()})
      })
    })
  }

  function shiritoriIntent (app) {
    const rawInput = app.getRawInput();
    if (rawInput === 'quit' || rawInput === 'exit' || rawInput === 'しりとりを終了') {
      app.tell('しりとりを終了します。');
    } else if (rawInput === 'pause') {
      app.tell('しりとりを終了します。');
    } else {
      let input = rawInput;
      console.log(input);
      
      kuromojiPromise(input)
      .then(readDB)
      .then(({input, data}) => {
        console.log(data);
        speakerLastWord = data['lastWord'];
        usedWordList = data['usedWords'];
        console.log(input);
        checkedInput = userWordCheck(input,speakerLastWord,usedWordList);
        switch (checkedInput.status) {
          case 'continue':
            usedWordList.push(input);
            //Speaker側で次の単語を決める
            db.ref('/shiritori/dictionary/'+smallToLarge(macronToVowel(input)).slice(-1)).on('value', (snap) => {
              speakerAnswer = decideNextWord(input,usedWordList,snap.val());
              switch (speakerAnswer.status) {
                case 'no_word_exist':
                  app.tell(`${input}ですね。単語が思い浮かびません。ユーザーの勝ちです。`);
                  timerRef.set({
                    msg: "stop"
                  });
                  timerRef.set({
                    msg: "start"
                  });
                  break;
                case 'bad_word':
                  app.tell(`${input}ですね。では、${speakerAnswer.word}。「んー」で終わってしまいました。ユーザーの勝ちです。`);
                  timerRef.set({
                    msg: "stop"
                  });
                  break;
                case 'word_exist':
                  inputPrompt = app.buildInputPrompt(true,`<speak>${input}ですね。では、${speakerAnswer.word}</speak>`,
                    ['<speak><break time="10s"/></speak>','.','<speak>時間オーバーです。わたしの勝ちです。</speak>']);
                  app.ask(inputPrompt);
                  usedWordList.push(speakerAnswer.word);
                  usedWordRef.set({
                    lastWord: speakerAnswer.word,
                    usedWords: usedWordList
                  });
                  timerRef.set({
                    msg: "stop"
                  });
                  timerRef.set({
                    msg: "start"
                  });
                  break;
              }
            });
            break;
          case 'retry':
            inputPrompt = app.buildInputPrompt(true,`<speak>${checkedInput.response}</speak>`,
              ['<speak><break time="10s"/></speak>','.','<speak>時間オーバーです。わたしの勝ちです。</speak>']);
            app.ask(inputPrompt);
            break;
          case 'lose':
            app.tell(checkedInput.response);
            timerRef.set({
              msg: "stop"
            });
            break;
          }
          return 0;
      })
      .catch('error');
    }
  }

  const actionMap = new Map();
  actionMap.set(app.StandardIntents.MAIN, welcomeIntent);
  actionMap.set(app.StandardIntents.TEXT, shiritoriIntent);
  app.handleRequest(actionMap);
});

const kanaToHira = (str) => {
  return str.replace(/[\u30a1-\u30f6]/g, (match) => {
    var chr = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(chr);
  });
};

const userWordCheck = (input, speakerLastWord, usedWordList) => {
  //ひらがなチェック
  if (!input.match(/^[ぁ-ゞー]+$/)) {
    return {status: 'retry', response: '日本語で入力してください。'};
  }
  //一文字チェック
  if (input.length <= 1) {
    return {status: 'retry', response: '二文字以上にしてください。'}
  }
  //小文字、長音の処理
  convertedSpeakerLastChar = smallToLarge(macronToVowel(speakerLastWord));
  //接続チェック
  if (input.slice(0,1) !== convertedSpeakerLastChar) {
    return {status: 'retry', response: `「${convertedSpeakerLastChar}ー」から始まる単語ではありません。別の単語にしてください。`}
  }
  //「ん」で終了
  if (input.slice(-1) === 'ん') {
    return {status: 'lose', response: `「${input}」ですね。「んー」で終わりました。私の勝ちです。`}
  }
  //重複チェック
  if (usedWordList.some((usedWord) => {return usedWord === input})) {
    return {status: 'retry', response: `「${input}」ですね。重複してます。別の単語にしてください。`}
  }
  //問題なし
  return {status: 'continue', response: ''};
};

const decideNextWord = (userLastWord, usedWordList, wordPool) => {
  convertedUserLastChar = smallToLarge(macronToVowel(userLastWord));
  selectedWordList = wordPool;
  notUsedWordList = differenceOfList(usedWordList, selectedWordList);
  nextWord = notUsedWordList[getRandomInt(notUsedWordList.length)];
  if (!selectedWordList || notUsedWordList.length === 0) {
    return {status: 'no_word_exist', word: ''};
  } else if (nextWord.slice(-1) === 'ん') {
    return {status: 'bad_word', word: nextWord};
  } else {
    return {status: 'word_exist', word: nextWord};
  }
};

const differenceOfList = (usedWordList, wordPool) => {
  newList = [];
  for (i = 0; i < wordPool.length; i++) {
    if (usedWordList.indexOf(wordPool[i]) === -1) {
      newList.push(wordPool[i]);
    }
  }
  return newList;
};

const smallToLarge = (char) => {
  charMap = {'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ'};
  if (char in charMap) {
    return charMap[char];
  } else {
    return char;
  }
};

const macronToVowel = (word) => {
  charMap = {'あ': 'あ', 'か': 'あ', 'さ': 'あ', 'た': 'あ', 'な': 'あ', 'は': 'あ', 'ま': 'あ', 'や': 'あ', 'ら': 'あ', 'わ': 'あ',
             'が': 'あ', 'ざ': 'あ', 'だ': 'あ', 'ば': 'あ', 'ぱ': 'あ', 'ぁ': 'あ', 'ゃ': 'あ',
             'い': 'い', 'き': 'い', 'し': 'い', 'ち': 'い', 'に': 'い', 'ひ': 'い', 'み': 'い', 'り': 'い',
             'ぎ': 'い', 'じ': 'い', 'ぢ': 'い', 'び': 'い', 'ぴ': 'い', 'ぃ': 'い',
             'う': 'う', 'く': 'う', 'す': 'う', 'つ': 'う', 'ぬ': 'う', 'ふ': 'う', 'む': 'う', 'ゆ': 'う', 'る': 'う',
             'ぐ': 'う', 'ず': 'う', 'づ': 'う', 'ぶ': 'う', 'ぷ': 'う', 'ぅ': 'う', 'ゅ': 'う',
             'え': 'え', 'け': 'え', 'せ': 'え', 'て': 'え', 'ね': 'え', 'へ': 'え', 'め': 'え', 'れ': 'え',
             'げ': 'え', 'ぜ': 'え', 'で': 'え', 'べ': 'え', 'ぺ': 'え', 'ぇ': 'え',
             'お': 'お', 'こ': 'お', 'そ': 'お', 'と': 'お', 'の': 'お', 'ほ': 'お', 'も': 'お', 'よ': 'お', 'ろ': 'お',
             'ご': 'お', 'ぞ': 'お', 'ど': 'お', 'ぼ': 'お', 'ぽ': 'お', 'ぉ': 'お', 'ょ': 'お'};
  if (word.slice(-1) === 'ー') {
    return charMap[word.slice(-2,-1)];
  } else {
    return word.slice(-1);
  }
};
