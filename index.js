
// Import dependencies
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Airtable = require("airtable");
const axios = require("axios");
const OpenAI = require("openai");

// Create an Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure Airtable
const airtableApiKey = process.env.AIRTABLE_KEY;
const airtableBaseId = process.env.AIRTABLE_BASE_ID;
const airtable = new Airtable({ apiKey: airtableApiKey });
const base = airtable.base(airtableBaseId);

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Handle incoming call
app.post("/voice", handleIncomingCall);

// Handle survey ID input
app.post("/handle-survey-id", handleSurveyIdInput);

// Handle field responses
app.post("/handle-response/:tableName/:responseId", handleFieldResponses);

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Function to handle incoming calls
async function handleIncomingCall(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();
  // Gather user input for survey ID
  twiml
    .gather({
      input: "dtmf",
      numDigits: 4, // Or as needed for your survey ID
      action: "/handle-survey-id",
    })
    .say("Please enter the survey ID.");
  res.type("text/xml");
  res.send(twiml.toString());
}

// Function to handle survey ID input
async function handleSurveyIdInput(req, res) {
  const surveyId = req.body.Digits; // Assuming DTMF input
  const tableName = `Survey_${surveyId}`;
  const table = base(tableName);

  const twiml = new twilio.twiml.VoiceResponse();

  // Create a new response in Airtable with the survey ID
  table.create({}, async (err, record) => {
    if (err) {
      twiml.say("Sorry, survey does not exist.");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const responseId = record.getId();

    // Redirect to the /handle-response route with the first field name using a POST request
    twiml.redirect(
      {
        method: "POST",
      },
      `/handle-response/${tableName}/${responseId}`
    );

    res.type("text/xml");
    res.send(twiml.toString());
  });
}

// Function to handle field responses
async function handleFieldResponses(req, res) {
  const responseId = req.params.responseId;
  const tableName = req.params.tableName;

  let fieldValue = req.body.SpeechResult; // Assuming speech input

  let remainingFields = req.query.remainingFields
    ? JSON.parse(req.query.remainingFields)
    : null;

  const lastResponses = req.query.lastResponses
    ? JSON.parse(req.query.lastResponses)
    : [];

  const { schema: rawSchema } = await getTableFieldNames(tableName);
  const formSchema = JSON.stringify(rawSchema, null, 2);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!remainingFields) {
    // Fetch all field names from getTableFieldNames() when remainingFields is null or undefined
    const { fieldNames: fields } = await getTableFieldNames(tableName);

    if (fields.length === 0) {
      // No fields to gather, end the call
      twiml.say("No fields to gather. Thank you. Goodbye.");
      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    remainingFields = fields;
  } else {
    const fieldName = remainingFields[0];
    // Extract response using AI
    const extractCompletion = await extractFieldValue(
      openai,
      formSchema,
      fieldName,
      fieldValue
    );

    if (extractCompletion.choices.length <= 0) {
      throw new Error();
    }

    fieldValue = extractCompletion.choices[0].message.content;

    const table = base(tableName);
    table.update(responseId, { [fieldName]: fieldValue }, (err, record) => {});

    remainingFields.shift();
  }

  if (remainingFields.length === 0) {
    // All fields have been gathered
    twiml.say("Thank you for providing your responses. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  // Current field name
  const field = remainingFields[0];
  // Generate prompt
  const chatCompletion = await generatePrompt(
    openai,
    lastResponses,
    formSchema,
    field
  );

  if (chatCompletion.choices.length <= 0) {
    throw new Error();
  }

  const rawRes = chatCompletion.choices[0].message;
  const message = rawRes.content;

  twiml
    .gather({
      input: "speech",
      speechTimeout: 2,
      action: `/handle-response/${tableName}/${responseId}?remainingFields=${encodeURIComponent(
        JSON.stringify(remainingFields)
      )}&lastResponses=${encodeURIComponent(
        JSON.stringify(
          fieldValue ? [...lastResponses, fieldValue] : lastResponses
        )
      )}`,
    })
    .say(message);
  res.type("text/xml");
  res.send(twiml.toString());
}

// Function to extract field value using AI
async function extractFieldValue(openai, formSchema, fieldName, fieldValue) {
  return openai.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `
    Your job is to extract the value from the user's response to a form survey.
    
    For example, if the user says "My phone number is 01 23 45 67 89", you should process it as "01 23 45 67 89"
    Sometimes, the user might input a digit, like 1. This should mean that they are selecting the second option in the list of options corresponding to the field.

    Form Schema: ${formSchema}

    Current Field: ${fieldName}

    User Response: ${fieldValue}

    Extracted Information: 
    `,
      },
    ],
    model: "gpt-4",
  });
}

// Function to generate a prompt for the user
async function generatePrompt(openai, lastResponses, formSchema, field) {
  return openai.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `
    You are a surveyor. Your job is to ask questions to people.

    Last responses: ${lastResponses.join(", ")}

    Form Schema: ${formSchema}

    Current field that you must fill in the form: ${field}
    
    For example, if field is "name", and there are no last responses, say: "Please, what is your name?"
    If there are last responses, react to the last one: "Great answer!", then transition to the current question "What is your age?"

    If there are NO (0) last responses, introduce yourself before asking the question.
    OTHERWISE, DO NOT INTRODUCE YOURSELF. ASK THE QUESTION DIRECTLY.

    If the ${field} form field has "options", list them out to the user one by one.
    Ask the user to give you the value, not a number corresponding to the value.

    ALWAYS REACT TO THE LAST RESPONSE (IF IT EXISTS), BEFORE ASKING A QUESTION.

    EXPLAIN THE EXPECTED FIELD (${field}) TYPE. PHONE NUMBER, EMAIL, TEXT, ETC...

    Short prompt to say to user: `,
      },
    ],
    model: "gpt-4",
  });
}

// Function to get field names from Airtable
async function getTableFieldNames(tableName) {
  const headers = {
    Authorization: `Bearer ${airtableApiKey}`,
  };

  try {
    const response = await axios.get(
      `https://api.airtable.com/v0/meta/bases/${airtableBaseId}/tables`,
      {
        headers,
      }
    );

    if (response.status !== 200) {
      throw new Error("Failed to fetch base schema");
    }

    const tables = response.data.tables;
    const table = tables.find((table) => table.name === tableName);

    if (!table) {
      throw new Error(`Table "${tableName}" not found.`);
    }

    const fieldNames = table.fields.map((field) => field.name);
    return { fieldNames, schema: table };
  } catch (error) {
    throw error;
  }
}
