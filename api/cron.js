import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import axios from 'axios';
import cheerio from 'cheerio';
import csvParser from 'csv-parser';
import { Transform } from 'stream';
import moment from 'moment';
import { sendEmail, updateEmailMailgenContent } from './mail.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;
const BATCH_SIZE = 1000;
const COLLECTION_NAME = 'files-storage';
let CSV_URL = null;

let cachedClient = null;

function getFormattedDate(d = new Date().toString()) {
    const date = new Date(d)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")

    return `${year}-${month}-${day}`
}

async function getMongoClient() {
    if (cachedClient) {
        return cachedClient;
    }

    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI is not defined');
    }

    const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    cachedClient = client;
    return cachedClient;
}

async function deleteOldDocuments(client, urlDate) {
    const db = client.db(MONGODB_DB);
    const collection = db.collection(COLLECTION_NAME);

    const tenDaysBeforeUrlDate = moment(urlDate).subtract(10, 'days').format('YYYY-MM-DD');
    const result = await collection.deleteMany({ date: { $lt: tenDaysBeforeUrlDate } });

    console.log(`Deleted ${result.deletedCount} documents older than 10 days from ${urlDate}`);
}

async function checkForDocumentsByDate(client, date) {
    const db = client.db(MONGODB_DB);
    const collection = db.collection(COLLECTION_NAME);

    const count = await collection.countDocuments({ date });

    return count > 0;
}

async function insertBatch(client, data) {
    const db = client.db(MONGODB_DB);
    const collection = db.collection(COLLECTION_NAME);

    await collection.insertMany(data);
    console.log(`Inserted batch of ${data.length} documents`);
}

async function generateData() {
    const results = [];
    const dateFromUrl = CSV_URL.match(/(\d{4}-\d{2}-\d{2})/)[0];

    return new Promise((resolve, reject) => {
        axios.get(CSV_URL, { responseType: 'stream' })
            .then(response => {
                response.data.pipe(csvParser())
                    .pipe(new Transform({
                        objectMode: true,
                        transform(data, encoding, callback) {
                            data.date = dateFromUrl; // add date to each document
                            callback(null, data);
                        }
                    }))
                    .on('data', (data) => results.push(data))
                    .on('end', () => {
                        console.log(`Parsed ${results.length} rows from CSV`);
                        resolve(results);
                    })
                    .on('error', (error) => {
                        console.error('Error reading CSV file:', error);
                        reject(error);
                    });
            })
            .catch(error => {
                console.error('Error fetching CSV file:', error);
                reject(error);
            });
    });
}

async function scrapeLinks() {
    try {
        const response = await axios.get('https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers');
        const html = response.data;

        const $ = cheerio.load(html);

        $('.govuk-link.gem-c-attachment__link').each((i, element) => {
            CSV_URL = $(element).attr('href');
        });
    } catch (error) {
        console.error('Error fetching or parsing the page:', error);
    }
}

async function performInsertion() {
    await scrapeLinks();
    console.log(`fetched url: ${CSV_URL}`)

    const client = await getMongoClient();
    const data = await generateData();
    const numberOfBatches = Math.ceil(data.length / BATCH_SIZE);
    const dateFromUrl = CSV_URL.match(/(\d{4}-\d{2}-\d{2})/)[0];

    try {
        console.log('Connecting to MongoDB...');
        await client.connect();
        console.log('Connected to MongoDB');

        await deleteOldDocuments(client, dateFromUrl);

        // check for existing documents with date parsed from the URL
        const hasDocumentsForDate = await checkForDocumentsByDate(client, dateFromUrl);
        if (hasDocumentsForDate) {
            console.log(`Documents for date ${dateFromUrl} already exist. Exiting...`);
            return;
        }

        const insertPromises = [];
        for (let i = 0; i < numberOfBatches; i++) {
            const batch = data.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            insertPromises.push(insertBatch(client, batch));
        }

        await Promise.all(insertPromises);

        console.log('Data inserted successfully');
    } catch (error) {
        console.error('Error inserting data:', error);
    } finally {
        // await client.close();
        console.log('MongoDB connection closed');
    }
}

async function sendUpdationEmail() {
    const client = await getMongoClient();
    try {
        await client.connect();
        const db = client.db(MONGODB_DB);

        // Calculate the date range for the previous day
        function getPreviousDate() {
            const today = new Date();
            today.setDate(today.getDate() - 1);
            return today;
        }
        const pastDate = getFormattedDate(getPreviousDate());
        console.log(`Past date: ${pastDate}`);

        const additionsCollection = db.collection('additions');
        const updatesCollection = db.collection('updates');
        const removalsCollection = db.collection('removals');

        const additionsSet = new Set();
        const updatesSet = new Set();
        const removalsSet = new Set();
        const companiesSet = new Set();

        const additions = await additionsCollection.find({
            date: pastDate
        }).toArray();
        additions.forEach((addition) => {
            additionsSet.add(addition.name);
            companiesSet.add(addition.name);
        });

        const updates = await updatesCollection.find({
            date: pastDate
        }).toArray();
        updates.forEach((update) => {
            updatesSet.add(update.name);
            companiesSet.add(update.name);
        });

        const removals = await removalsCollection.find({
            date: pastDate
        }).toArray();
        removals.forEach((removal) => {
            removalsSet.add(removal.name);
            companiesSet.add(removal.name);
        });

        const companiesArray = Array.from(companiesSet);

        const followedEmailsCollection = db.collection('followedemails');
        const followedEmails = await followedEmailsCollection.find({
            companyName: { $in: companiesArray }
        }).toArray();

        // additions.forEach(async (addition) => {
            followedEmails.forEach(async (followedEmail) => {
                // if (followedEmail.companyName === addition.name) {
                if (additionsSet.has(followedEmail.companyName)) {
                    await sendEmail({
                        email: followedEmail.email,
                        subject: "Addition Email",
                        mailgenContent: updateEmailMailgenContent('addition', followedEmail.companyName)
                    });
                }

                if (updatesSet.has(followedEmail.companyName)) {
                    await sendEmail({
                        email: followedEmail.email,
                        subject: "Updation Email",
                        mailgenContent: updateEmailMailgenContent('updation', followedEmail.companyName)
                    });
                }

                if (removalsSet.has(followedEmail.companyName)) {
                    await sendEmail({
                        email: followedEmail.email,
                        subject: "Removal Email",
                        mailgenContent: updateEmailMailgenContent('removals', followedEmail.companyName)
                    });
                }

            });
        // });

        // updates.forEach(async (update) => {
            // followedEmails.forEach(async (followedEmail) => {
            //     // if (followedEmail.companyName === update.name) {
            // });
        // });

        // removals.forEach(async (removal) => {
            // followedEmails.forEach(async (followedEmail) => {
            //     // if (followedEmail.companyName === removal.name) {
            // });
        // });
    } catch (error) {
        console.error('Error in sending email:', error);
    } finally {
        await client.close();
    }
}

export default async function handler() {
    console.log('Data insertion started');
    await performInsertion();
    //sendUpdationEmail();
}
