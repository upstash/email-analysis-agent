import { serve } from "@upstash/workflow/nextjs";
import { tool } from 'ai';
import { z } from "zod";
import pdf from "pdf-parse";
import { Resend } from 'resend';

type EmailPayload = {
    message: string,
    subject: string,
    to: string,
    attachment?: string,
    attachment_type?: string
}

const resend = new Resend(process.env.RESEND_API_KEY);

export const { POST } = serve<EmailPayload>(async (context) => {
    const { message, subject, to, attachment, attachment_type } = context.requestPayload;
    const model = context.agents.openai("deepseek-chat",
        {
            baseURL: "https://api.deepseek.com",
            apiKey: process.env.DEEPSEEK_API_KEY
        }
    );

    // PDF processing agent
    const pdfAgent = context.agents.agent({
        model,
        name: 'pdfAgent',
        maxSteps: 3,
        background: 'You are a specialist in extracting and summarizing key information from PDF documents.',
        tools: {
            processPDF: tool({
                description: 'Process and extract text from PDF attachments',
                parameters: z.object({
                    attachmentUrl: z.string().describe('URL of the PDF attachment')
                }),
                execute: async ({ attachmentUrl }) => {
                    if (!attachmentUrl || attachment_type !== 'application/pdf') {
                        return "NO_ATTACHMENT";
                    }

                    const response = await fetch(attachmentUrl);
                    const fileContent = await response.arrayBuffer();
                    const buffer = Buffer.from(fileContent);

                    try {
                        const data = await pdf(buffer);
                        return { content: data.text };
                    } catch (error) {
                        console.error('Error parsing PDF:', error);
                        return { content: 'Unable to extract PDF content' };
                    }
                }
            })
        }
    });

    // Email composition agent
    const emailAgent = context.agents.agent({
        model,
        name: 'emailAgent',
        maxSteps: 3,
        background: `You are an email specialist who writes professional, concise responses. 
                    You maintain conversation flow while being clear and helpful.`,
        tools: {
            sendEmail: tool({
                description: 'Send email using Resend API',
                parameters: z.object({
                    to: z.string().describe('Recipient email address'),
                    subject: z.string().describe('Email subject'),
                    content: z.string().describe('Email content')
                }),
                execute: async ({ to, subject, content }) => {

                    const emailResponse = await resend.emails.send({
                        from: "Analysis Agent <onboarding@resend.dev>",
                        to,
                        subject,
                        text: content
                    })

                    return emailResponse;
                }
            })
        }
    });

    // Step 1: Process and summarize PDF if exists
    let pdfContent = '';
    if (attachment) {
        const { text } = await context.agents.task({
            agent: pdfAgent,
            prompt: `Process this PDF attachment using the processPDF tool.
                    If the attachment doesn't exist or is not a PDF, tool returns NO_ATTACHMENT string.
                    If there is no attachment, don't retry processing the PDF.
                    Attachment URL: ${attachment}
                    
                    Extract and summarize the key information from this PDF.
                    Return the extracted content in a clear, organized format.`
        }).run();
        pdfContent = text;
    }

    // Step 2: Compose and send email response
    await context.agents.task({
        agent: emailAgent,
        prompt: `You are going to compose an email and send it using the sendEmail tool.
				
		        Email Parameters:
                TO: ${to}
                SUBJECT: ${subject}
                MESSAGE CONTEXT: ${message}
                PDF CONTENT: ${pdfContent}
	
                First, compose your email response. Then, use the sendEmail tool with these exact parameters:
                {
                    "to": "${to}",
                    "subject": "Analysis: ${subject}",
                    "content": "YOUR_EMAIL_CONTENT"
                }
	
                Make sure to replace YOUR_EMAIL_CONTENT with your actual email text in a single line, using \\n for newlines.
                The response should be concise but address all key points from both the message and PDF content.`
    }).run();
});