import Mailgen from "mailgen";
import nodemailer from "nodemailer";
import dotenv from "dotenv"
dotenv.config()

/**
 *
 * @param {{email: string; subject: string; mailgenContent: Mailgen.Content; }} options
 */
export const sendEmail = async (options) => {
    // Initialize mailgen instance with default theme and brand configuration
    const mailGenerator = new Mailgen({
        theme: "default",
        product: {
            name: "UK Sponsor License Checker",
            link: "https://www.google.com/",
        },
    });

    // Generate the plaintext version of the e-mail (for clients that do not support HTML)
    const emailTextual = mailGenerator.generatePlaintext(options.mailgenContent);

    // Generate an HTML email with the provided contents
    const emailHtml = mailGenerator.generate(options.mailgenContent);

    // Create a nodemailer transporter instance which is responsible to send a mail
    const transporter = nodemailer.createTransport({
        host: process.env.HOST,
        port: process.env.PORT,
        auth: {
            user: process.env.USER,
            pass: process.env.PASSWORD,
        },
    });

    const mail = {
        from: "notification@breezeconsult.org",
        // from: "notifications@compliance-360.org",
        to: options.email,
        subject: options.subject,
        text: emailTextual,
        html: emailHtml,
    };

    try {
        const res = await transporter.sendMail(mail);
        console.log(res);
    } catch (error) {
        console.log(
            "Email service failed silently. Make sure you have provided your credentials in the .env file"
        );
        console.log("Error: ", error);
    }
};


export const updateEmailMailgenContent = (actionType, companyName) => {
    let actionMessage;
    switch (actionType) {
        case 'addition':
            actionMessage = `The company <strong>${companyName}</strong> has been added.`;
            break;
        case 'updation':
            actionMessage = `The details of the company <strong>${companyName}</strong> have been updated.`;
            break;
        case 'removals':
            actionMessage = `The company <strong>${companyName}</strong> has been removed.`;
            break;
        default:
            actionMessage = `An action has been performed on the company <strong>${companyName}</strong>.`;
    }

    return {
        body: {
            name: "Subscriber",
            intro: actionMessage,
            outro: `If you have any questions, feel free to reach out to us.`,
        },
    };
};