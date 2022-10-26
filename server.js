const express = require('express')
const path = require('path')
const socketIO = require('socket.io');
const PORT = process.env.PORT || 5050;
const fetch = require('node-fetch');
const Discord = require("discord.js");
const got = require('got');
const { MongoClient } = require('mongodb');
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const config = require("./config.json");
const alchemyAPIKey = config.alchemyAPI;
const chalk = require('chalk');
const web3 = createAlchemyWeb3(`wss://eth-mainnet.g.alchemy.com/v2/${alchemyAPIKey}`);
const mongoURI = config.mongoURI;
const mongoDB = config.mongoDB;
const mongoCollection = config.mongoCollection;
const moduleAPI = config.moduleAPI;
const webhookClient = new Discord.WebhookClient({url: config.webhook});
const client = new MongoClient(mongoURI);
const database = client.db(mongoDB);
const walletAddresses = database.collection(mongoCollection);
const gemContract = web3.utils.toChecksumAddress("0x83C8F28c26bF6aaca652Df1DbBE0e1b56F8baBa2");
const seaportContract = web3.utils.toChecksumAddress("0x00000000006c3852cbEf3e08E8dF289169EdE581");
const oldOSContract = web3.utils.toChecksumAddress("0x7f268357A8c2552623316e2562D90e642bB538E5");
const looksRareContract = web3.utils.toChecksumAddress("0x59728544B08AB483533076417FbBB2fD0B17CE3a");
const x2Contract = web3.utils.toChecksumAddress("0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3");
const nullMintAddress = web3.utils.toChecksumAddress("0x0000000000000000000000000000000000000000");
let tokenArr = [];
let hashArr = [];

const sleep = (delay) => new Promise(resolve => {
  console.log(chalk.yellow.bold`Waiting ${delay}ms`);
  setTimeout(resolve, delay)
});

// start the express server with the appropriate routes for our webhook and web requests
var app = express();

app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json({limit: '50mb'}))
app.get('/*', (req, res) => res.status(404).end())
app.listen(PORT, () => console.log(`Listening on ${PORT}`))
app.post('/alchemyhook', async (req, res) => {
  try {
    res.sendStatus(200);
    return formatRequest(req);
  }
  catch(e){
    console.log(e);
  }
})

async function formatRequest(req){
  let body = req.body.event.activity;
  let tokenId, contractAddress, hash, toAddress, category, isERC721, tokenTo, tokenFrom;
  let id = req.body.id;

  if(body.length > 1){
    let txHash = body[0].hash;
    let [txFrom, txTo, value] = await getTransactionInfo(txHash);
    let bodyLen = body.length;

    for(let i in body){
      category = body[i].category;
      isERC721 = body[i].erc721TokenId;
      toAddress = web3.utils.toChecksumAddress(body[i].toAddress);
      contractAddress = body[i].rawContract.address;
      hash = body[i].hash;
     
      if(category == "token" || category == "erc1155") {
        if(category == "erc1155"){
          tokenId = web3.utils.hexToNumberString(body[0].erc1155Metadata[0].tokenId);
        }
        else if(isERC721) {
          tokenId = web3.utils.hexToNumber(isERC721);
        }
      }

      tokenArr.push(tokenId);
      hashArr.push(hash)
    }

    let hashesAreEqual = await checkElementsAreEqual(hashArr);
    let sortedArr = await sortArr(tokenArr);
    let sortedArrLength = sortedArr.length;

    if(hashesAreEqual){
      if(body[0].fromAddress == nullMintAddress){
        console.log("Minting NFTs. Setup Discord Alert.");
      }
      else{
        console.log(sortedArr.length);
      }
    }

  }
  else if(body.length == 1){
    category = body[0].category;
    isERC721 = body[0].erc721TokenId;
    contractAddress = body[0].rawContract.address;
    tokenTo = web3.utils.toChecksumAddress(body[0].toAddress)
    tokenFrom = web3.utils.toChecksumAddress(body[0].fromAddress)
    hash = body[0].hash;

    if(category == "external" || category == "internal"){
      console.log(`Ignoring ${category} Transaction`);
    }

    else if(category == "token" || category == "erc1155"){
      if(category == "erc1155"){
        tokenId = web3.utils.hexToNumberString(body[0].erc1155Metadata[0].tokenId);
      }
      else if(isERC721) {
        tokenId = web3.utils.hexToNumber(isERC721);
      }

      let lastSale;
      let blockHash = body[0].blockNum;
      let blockNumber = web3.utils.hexToNumber(blockHash) - 1;
      let blockInfo = await web3.eth.getBlock(blockNumber);
      let blockTimestamp = blockInfo.timestamp;
      let tokenInfo = await retrieveMetadata(contractAddress, tokenId);
      let [txFrom, txTo, value] = await getTransactionInfo(hash);
      let formattedValue = Number(web3.utils.fromWei(value, "ether")).toFixed(3);
      let checkSumFrom = web3.utils.toChecksumAddress(txFrom);
      let checkSumTo = web3.utils.toChecksumAddress(txTo);
      let numSales = tokenInfo.numSales;
      let tokenImg = tokenInfo.imageURL;
      let tokenName = tokenInfo.tokenName;
      let collectionName = tokenInfo.collectionName;
      let slug = `https://opensea.io/collection/${tokenInfo.slug}`;
      let [saleType, user, userAddress] = await queryDB(tokenFrom, tokenTo);
      let holderCount = await getHolderCount(userAddress, contractAddress);     
      let marketPlaceInfo = await getMarketPlace(checkSumTo);
      let marketPlace = marketPlaceInfo.marketPlace;
      let avatarURL = marketPlaceInfo.avatarURL;
      let absoluteValue = (formattedValue[4] != 0) ? formattedValue : Number(formattedValue).toFixed(2);

      //updating code

      if(checkSumTo == seaportContract || checkSumTo == x2Contract || checkSumTo == looksRareContract){
        if(saleType == "PURCHASE" && absoluteValue == "0.00"){
          console.log(`LIKELY SPAM.\nUser: ${user}\nTX: ${hash}`)
        }
        else{
          return sendMarketTransferToDiscord(marketPlace, avatarURL, saleType, tokenName, contractAddress, tokenImg, tokenId, absoluteValue, slug, userAddress, user, holderCount);
        }
      }
    }
    else{
      console.log("Non ERC-721/1155 Interaction.")
    }
  }
}

async function getMarketPlace(address){
  let newObj = {};

  if(address == seaportContract || address == oldOSContract){
      newObj.marketPlace = "OPENSEA";
      newObj.avatarURL = "https://storage.googleapis.com/opensea-static/Logomark/Logomark-Blue.png";
  }
  else if(address == looksRareContract){
      newObj.marketPlace = "LOOKSRARE"
      newObj.avatarURL = "https://seeklogo.com/images/L/looksrare-logo-8A0876C037-seeklogo.com.png";
  }
  else if(address == x2Contract){
      newObj.marketPlace = "X2Y2"
      newObj.avatarURL = "https://i.imgur.com/E29EfY1.png"
  }

  return newObj;
}

async function sendMarketTransferToDiscord(marketPlace, avatarURL, saleType, tokenName, contractAddress, tokenImg, tokenId, value, slug, userAddress, user, holderCount){
  let saleColor;

  if(saleType == "SALE"){
    saleColor = "#FF3E20";
  }
  else if(saleType == "PURCHASE"){
    saleColor = "#8CEF74";
  }

  const embed = new Discord.MessageEmbed()
    .setAuthor(`${marketPlace} ${saleType}`)
    .setTitle(`${tokenName}`)
    .setColor(saleColor)
    .setURL(`https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`)
    .setThumbnail(tokenImg)
    .addField("User", `${user}`, true)
    .addField("Amount Held", `${holderCount}`, true)
    .addField("Relevant Links", `<:opensea:1014994189999685632> [OpenSea Collection](${slug})\n<:nerds:1014994223491207238> [NFTNerds Link](https://nftnerds.ai/collection/${contractAddress}/liveview)\n<:eth:1014992545538904134> [User Address](https://etherscan.io/address/${userAddress})`, false)
    .addField("Value", `${value}Ξ`, false)
    .setTimestamp()

  webhookClient.send({
      username: `${marketPlace} MONITOR`,
      avatarURL: avatarURL,
      embeds: [embed]
  })
}

async function sendMintToDiscord(amt, collectionName, txHash, contractAddress, tokenImg, value, tokenImg, userAddress, slug, user){
  const embed = new Discord.MessageEmbed()
    .setTitle(`NEW MINT OF ${amt}: ${collectionName}`)
    .setColor("#ffffff")
    .setURL(`https://www.etherscan.io/tx/${txHash}`)
    .setThumbnail(tokenImg)
    .addField("User", `${user}`, true)
    .addField("Relevant Links", `<:opensea:1014994189999685632> [OpenSea Collection](${slug})\n<:nerds:1014994223491207238> [NFTNerds Link](https://nftnerds.ai/collection/${contractAddress}/liveview)\n<:eth:1014992545538904134> [User Address](https://etherscan.io/address/${userAddress})`, false)
    .addField("Value", `${value}Ξ`, false)
    .setTimestamp()

  webhookClient.send({
      username: `MINT MONITOR`,
      avatarURL: avatarURL,
      embeds: [embed]
  })
}

async function sendGemSweepToDiscord(amt, contractAddress, collectionName, collectionLink, collectionImg, value, txHash, user="test"){

  const embed = new Discord.MessageEmbed()
    .setTitle(`${amt} ${collectionName} Gem Swept for ${value}Ξ `)
    .setColor("#f771b5")
    .setURL(`https://www.etherscan.io/tx/${txHash}`)
    .addField("Relevant Links", `<:opensea:1014994189999685632> [OpenSea Collection](${collectionLink})\n<:nerds:1014994223491207238> [NFTNerds Link](https://nftnerds.ai/collection/${contractAddress}/liveview)\n<:eth:1014992545538904134> [Buyer Address](${collectionLink})`, false)
    .addField("Buyer", `${user}`, false)
    .setThumbnail("https://i.gifer.com/Z23Y.gif")
    .setImage(collectionImg)
    .setTimestamp()

  webhookClient.send({
      username: `Gem Sweeps`,
      avatarURL: "https://pbs.twimg.com/profile_images/1469735318488293380/AuOdfwvH_400x400.jpg",
      embeds: [embed]
  })
}

async function queryDB(tokenFrom, tokenTo){
  try{
    await client.connect();

    let saleType;
    let user;
    let userAddress;
    let checkSumTokenFrom = web3.utils.toChecksumAddress(tokenFrom);
    let checkSumTokenTo = web3.utils.toChecksumAddress(tokenTo);
    const queryFrom = {address: checkSumTokenFrom};
    const queryTo = {address: checkSumTokenTo};
    const searchFrom = await walletAddresses.findOne(queryFrom);
    const searchTo = await walletAddresses.findOne(queryTo);

    if(searchFrom == null){
      saleType = "PURCHASE"
      user = searchTo.user;
      userAddress = tokenTo;
    }
    else{
      saleType = "SALE"
      user = searchFrom.user;
      userAddress = tokenFrom;
    }

    let saleInfo = [saleType, user, userAddress];

    return saleInfo;
  }
  catch(e){
    console.log("ERR", e);
  }
}

async function updateDB(arr){
  try{
      await client.connect();
      const result = await walletAddresses.insertMany(arr);

      console.log(result);
  }
  catch(err){
      console.error(err);
  }
}

async function getHolderCount(userAddress, contractAddress){
  let headers = {
    "Accept": "application/json",
    "Host" : "eth-mainnet.g.alchemy.com"
  }

  let opts = {
    url: `https://eth-mainnet.g.alchemy.com/nft/v2/${alchemyAPIKey}/getNFTs?owner=${userAddress}&contractAddresses[]=${contractAddress}&withMetadata=false`,
    headers: headers,
    responseType: "json"
  }

  try{
    let r = await got(opts);

    if(r.statusCode === 200 && r.body){
      let body = r.body;
      let totalCount = body.totalCount;

      return totalCount;
    }
  }
  catch(e){
    console.log(`Failed to get holder count for contract: ${contractAddress}}`)
  }

}

async function sortArr(arr){
  
  let sorted = arr.sort(function(a, b) {
    return a - b;
  });

  return sorted;
}

async function checkElementsAreEqual(array) {
  const result = array.every(e => {
    if (e === array[0]) {
      return true;
    }
  });

  return result;
}

async function getTransactionInfo(hash){
  let txInfo = await web3.eth.getTransaction(hash);

  let fromAddress = txInfo.from;
  let toAddress = txInfo.to;
  let value = txInfo.value;

  let txInfoArr = [fromAddress, toAddress, value];

  return txInfoArr;
}

async function retrieveMetadata(contractAddress, tokenId){
  let headers = {
    "Accept": "application/json",
  }

  let opts = {
    url: `https://api.modulenft.xyz/api/v2/eth/nft/token?contractAddress=${contractAddress}&tokenId=${tokenId}`,
    headers: headers,
    responseType: "json"
  }

  try {
    let r = await got(opts);

    if(r.statusCode == 200 && r.body){    
        const body = r.body.data.collection;
        const tokenMeta = r.body.data.metadata;
        let imageURL;
        let slug = body.slug;
        let collectionName = body.name;
        let tokenName = `${collectionName} #${tokenId}`;
        // let lastSale = Number(web3.utils.fromWei(body.last_sale.total_price, "ether")).toFixed(3);
        
        if(body.image_url != null){
          imageURL = tokenMeta.image;
        }
        else{
          imageURL = body.images.image_url;
        }

        let metadata = {
          numSales : numSales,
          imageURL: imageURL,
          tokenName: tokenName,
          slug: slug,
          collectionImage: collectionImage,
          collectionName: collectionName
        }

        return metadata;
    }
  }

  catch (e) {
    console.log(`Failed to get metadata`, e);

    let tokenName = "OpenSea Asset";
    let tokenImg = "https://64.media.tumblr.com/091dd80d6b490655bf64bc6610b06d26/f72b7f4622a19b9d-6a/s400x600/6fb19aa97057f11c6ed8fe400a1dfd8e82d1649d.png";
    let tokenInfo = [tokenName, tokenImg];

    return tokenInfo;

  }
}