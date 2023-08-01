const express=require("express")
const cors = require("cors")
const server = express();
const path=require("path");
const PORT=process.env.PORT || 8000;
const mysql=require("mysql")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const cookie_parser= require("cookie-parser")
const nodemailer=require("nodemailer")
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser')

server.use(bodyParser.json())
server.use(cors())
server.use(express.json())
server.use(cookie_parser())

server.use(express.static('build'));


server.get("/api/send",(req,res)=>{
    const stoff = req.cookies["bought"]
    res.status(201).json(stoff)
})

server.get("/api/send_kunde",(req,res)=>{
    const kunde = req.cookies["kunde"]
    res.status(200).json(kunde)
})

server.post("/api/login",(req,res)=>{
    const connection = mysql.createConnection({
        host: process.env.NEXT_AZURE_HOST,
        user: process.env.NEXT_AZURE_USER_NAME,
        password: process.env.NEXT_AZURE_PASS,
        database: process.env.NEXT_AZURE_DATABASE,
        port: process.env.NEXT_AZURE_PORT
      })
    const q= "SELECT * FROM administrator"
    connection.query(q,[req.body.brukernavn],async (err,results,fields)=>{
        if(results.length == 0){
            return res.status(500).json({funka:"bruh"})
        }
        if(await bcrypt.compare(req.body.pass, results[0].pass)){
            const accesstoken = jwt.sign(req.body,process.env.AUTH_KEY)
            const femtim = 5*60*60*1000
            res.cookie("authorization",accesstoken, {
                maxAge:femtim,
                httpOnly: true,
                path:"/",
                sameSite:"strict",
                secure:false
            })
            return res.status(201).send(accesstoken)
        }
        res.status(500).json({funka:"nei"})
        
    })
    connection.end()
})

server.post("/api/kjopt",(req,res)=>{
    const bought = req.body.bought;
    const kunde = req.body.kunde;
    const tofemmin=25*60*1000;
    res.cookie("kjopt",JSON.stringify(bought),{
        maxAge:tofemmin,
        httpOnly: true,
        path:"/",
        sameSite:"strict",
        secure:false
    })
    res.cookie("kunde",JSON.stringify(kunde),{
        maxAge:tofemmin,
        httpOnly: true,
        path:"/",
        sameSite:"strict",
        secure:false
    })
    res.sendStatus(201)
})

server.post("/api/send",(req,res)=>{
    const femtim = 5*60*60*1000
    res.cookie("bought",req.body, {
        maxAge:femtim,
        httpOnly: true,
        path:"/",
        sameSite:"strict",
        secure:false
    })
    res.status(201).send({accepted: true})
})

server.post("/api/create-payment-intent",async (req,res)=>{
    const { items } = req.body;
    let bought = req.cookies["kjopt"]
    let kunde = req.cookies["kunde"]
    bought=JSON.parse(bought)
    kunde=JSON.parse(kunde)
    let sikker=true;

    //sikkerhets sjekk
    async function check(arr){
        items.forEach((value,index)=>{
            if(arr[index].id != value.id || arr[index].amount != value.amount){
                sikker=false
            }
        })
        return sikker;
    }
    
    await check(bought)
    
    if(sikker){
        // hent data fra database, lag funksjon for å regne ut amount og sett det inn
        const connection = mysql.createConnection({
            host: process.env.NEXT_AZURE_HOST,
            user: process.env.NEXT_AZURE_USER_NAME,
            password: process.env.NEXT_AZURE_PASS,
            database: process.env.NEXT_AZURE_DATABASE,
            port: process.env.NEXT_AZURE_PORT
          })
        const resultat=await new Promise((res,rej)=>{
            const q = "SELECT * FROM produkter";
            connection.query(q,(err,result,fields)=>{
                if(err){
                    rej(err)
                } else{
                    res(result)
                }
            })
        })
        const produkter=resultat;
        const kjøpte_DB= items.map((ene)=> {
            const ene_prod=produkter.find(prod=>prod.id==ene.id)
            return {amount:ene.amount, pris: ene_prod.pris}
        })
        let total=0;
        function sum(a,b){
            c=a+b
            return c
        }
        
        kjøpte_DB.forEach((element) => {
            const verdi=element.amount*element.pris;
            total=sum(total,verdi)
        });

        let ttq=0;
        bought.forEach((ene)=>{
          const prod=produkter.find((pr)=>pr.id===ene.id)
          if(prod.navn.split(" ")[1]==="kg"){
            ttq+=ene.amount*parseInt(prod.navn.split(" ")[0])*1000;
          }else{
            ttq+=ene.amount*parseInt(prod.navn.split(" ")[0]);
          }
        })

        if(ttq>4000){
            total=total+600;
          } else if(ttq>500 && ttq<=4000){
            total=total+350;
          }else if(ttq>100 && ttq<=500){
            total=total+200;
          } else if(ttq>25 && ttq<=100){
            total=total+100;
          } else{
            total=total+40;
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: total*100,
            currency: "NOK",
            automatic_payment_methods: {
                enabled: true,
            },
            metadata:{
                kjopt:JSON.stringify(bought),
                kunde:JSON.stringify(kunde)
            }
        });
        
        res.send({
            clientSecret: paymentIntent.client_secret,
        });
    } else{
        res.status(400).send()
    }
})


server.post('/api/min_webhook', express.raw({type: 'application/json'}), (req, res) => {
    let event=req.body.type;
    try{
        if(event=="payment_intent.succeeded"){
            const data=req.body.data.object;
            const bought = data.metadata.kjopt;
            const kunde = JSON.parse(data.metadata.kunde);
            const betaling_id=data.id;
            const amount= data.amount/100;
            const currency=data.currency;
            var kunde_id=Math.floor(Math.random()*10000000);

            const connection = mysql.createConnection({
                host: process.env.NEXT_AZURE_HOST,
                user: process.env.NEXT_AZURE_USER_NAME,
                password: process.env.NEXT_AZURE_PASS,
                database: process.env.NEXT_AZURE_DATABASE,
                port: process.env.NEXT_AZURE_PORT 
            })

            const q="INSERT INTO kunde (id,navn,email,telefon,country,zip_code,city,Adresse,betaling_id) VALUES ? "
            const verdier_kunde=[[kunde_id,kunde.navn,kunde.email,kunde.telefon,kunde.country,kunde.zip_code,kunde.city,kunde.Adresse,betaling_id]];
            connection.query(q,[verdier_kunde],(err,results)=>{
                if(err) throw err
            });
            
            const q2="INSERT INTO salg (kunde_id,betaling_id,produkt_kjøpt,betalt,valuta) VALUES ? "
            const Verdier_salg=[[kunde_id,betaling_id,bought,amount,currency]]
            connection.query(q2,[Verdier_salg],(err,result,field)=>{
                if(err) throw err
            })

            const resu=new Promise((resolve,reject)=>{
                connection.query(`SELECT id FROM salg WHERE kunde_id = ${kunde_id} AND betaling_id= "${betaling_id}"`,(err,result,fields)=>{
                    if(err){
                        reject(err)
                    }else{
                        resolve(result)     
                    }
                })
            }).then((result)=>{
                const id=result[0].id
                connection.query("SELECT * FROM produkter",(err,results,field)=>{
                    const new_bought=JSON.parse(bought)
                    const dataen=new_bought.map((ene)=>{

                        function genere_img_path(){
                            const bokstavene=["a","b","c","d","f","g","g","j","k","m","x"]
                            let bokstav=""
                            for(let i=0; i<=5; i++){
                                rand_tall=Math.floor(Math.random()*10)
                                bokstav_valg=bokstavene[rand_tall]
                                bokstav=bokstav+bokstav_valg;
                            }
                            bokstav=bokstav+"@";
                            for(let i=0; i<=5; i++){
                                rand_tall=Math.floor(Math.random()*10)
                                bokstav_valg=bokstavene[rand_tall]
                                bokstav=bokstav+bokstav_valg;
                            }
                            bokstav="cid:"+bokstav+".info";
                            return bokstav

                        }

                        const res=results.find(prod=>prod.id==ene.id)
                        const full_res={amount:ene.amount, navn:res.navn, pris:res.pris, img:res.img, img_path:genere_img_path()}
                        return full_res
                    })

                    const html=`
                    <h2> Dear ${kunde.navn}, Thank you for buying at Zsaffron </h2>
                    <h3> Your order will be sendt as soon as possible to the adress</h3> <h3>${kunde.Adresse}, ${kunde.zip_code} ${kunde.city}, ${kunde.country}</h3> 
                    <h3>You are given a customer-id and a order-id for later references</h3> <h3>customer-id:${kunde_id}   order-id:${id}</h3>
                    <h3>order detail:</h3>
                    ${dataen.map((en)=>{
                        return `<div>
                            <h4>quantity:${en.amount} price:${en.pris}</h4>
                            <img src="${en.img_path}" width="100px" height="100px" />
                            </div>`
                    })}
                    <h3>total:${amount}${currency}</h3>
                    <h4>Thank you for choosing Zsaffron. We will keep you informed about your order's status and send you a notification once your package has been shipped. We appreciate your business and hope to welcome you back soon</h4>
                    `;
                    
                    const attach=dataen.map((en)=>{
                        const path="./pics"+en.img
                        const filnavn=path.split("/")[3]
                        const cid=en.img_path.split(":")[1]
                        return {filename:filnavn, path:path, cid:cid}
                    })
                    const transporter=nodemailer.createTransport({
                        service:"gmail",
                        host:"smtp.gmail.com",
                        secure:true,
                        auth:{
                            user:process.env.MAIL,
                            pass:process.env.MAIL_PASS
                        }
                    })
                    const info=transporter.sendMail({
                        from:"Zsaffron <zsaffroncontact@gmail.com>",
                        to:`${kunde.email}`,
                        subject:"order confirmation",
                        html:html,
                        attachments:attach
                    })
                    connection.end()
                })
            })

            return res.status(200).json({success:true})
        }
        if(event=="payment_intent.payment_failed"){
            res.clearCookie("kjøpt")
            res.clearCookie("kunde")
            res.status(400).json({success:false})
        }
    }catch{
        res.status(400).json({success:false})
        return;
    }
    res.status(200).json({success:true})
});

server.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'build', 'index.html'));
});


server.listen(PORT,()=>{console.log(`app listening on port: ${PORT} `)})
