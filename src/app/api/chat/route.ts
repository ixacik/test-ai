import { z } from "zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

export const maxDuration = 60;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define the quiz schema using Zod
const QuizOptionSchema = z.object({
  option: z.string().min(1, "Option text cannot be empty."),
  correct: z.boolean(),
});

const QuizQuestionSchema = z.object({
  question: z.string().min(1, "Question text cannot be empty."),
  options: z
    .array(QuizOptionSchema)
    .min(2, "A question must have at least two options.")
    .max(4, "A question cannot have more than four options."),
});

const QuizSchema = z.object({
  quiz: z
    .array(QuizQuestionSchema)
    .min(1, "The quiz must have at least one question.")
    .max(10, "The quiz cannot have more than 10 questions."),
});

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { vectorStoreId, existingQuestions = [] } = body;

    if (!vectorStoreId) {
      return new Response(
        JSON.stringify({
          message:
            "Vector store ID is required. Please upload PDF files first.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Validate existingQuestions
    if (!Array.isArray(existingQuestions)) {
      return new Response(
        JSON.stringify({
          message: "existingQuestions must be an array of strings.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Verify that the vector store exists
    try {
      await client.vectorStores.retrieve(vectorStoreId);
    } catch (error: unknown) {
      const errorMessage =
        error && typeof error === "object" && "message" in error
          ? (error as Error).message
          : "Unknown error";
      return new Response(
        JSON.stringify({
          message:
            "Vector store not found or inaccessible. Please upload files again.",
          error: errorMessage,
        }),
        {
          status: 404,
          headers: jsonHeaders,
        },
      );
    }

    // Check if vector store has files
    const files = await client.vectorStores.files.list(vectorStoreId);
    if (!files.data || files.data.length === 0) {
      return new Response(
        JSON.stringify({
          message:
            "No files found in the vector store. Please upload PDF files first.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Create an assistant with file search capabilities
    const assistant = await client.beta.assistants.create({
      name: "Quiz Generator Assistant",
      instructions: `You are an expert quiz generator. Your task is to create high-quality multiple-choice questions based on the content in the provided documents.

Rules:
1. Generate exactly 10 multiple-choice questions
2. Each question must have exactly 4 options
3. Each question must have exactly one correct answer
4. Questions should test understanding, not just memorization
5. Make sure each option is a plausible answer to avoid obvious choices

This is a sample style, of the questions that should be asked:
# Cognitive Science Practice Questions (Bermúdez-Based)

---

### **Question 1**
**In Marr's model, depth and orientation information appears in which stage of visual processing?**

- [ ] The primal sketch
- [x] The 2.5D sketch
- [ ] The 3D sketch

---

### **Question 2**
**Electroencephalograms (EEGs) allow experimenters to study event-related potentials.**

- [x] True
- [ ] False

---

### **Question 3**
**The patient S. M. who suffered damage to the amygdala showed deficits in experiencing and identifying which of the following emotions?**

- [ ] Anger
- [ ] Sadness
- [ ] Disgust
- [x] Fear

---

### **Question 4**
**For Bayesians, a belief is a ...**

- [ ] Truth value
- [ ] Sentence in the language of thought
- [x] Probability assignment

---

### **Question 5**
**Dynamical systems theorists emphasize which of the following basic ideas?**

- [x] The human mind is an autonomous problem-solver.
- [ ] Human beings are embodied and embedded in their environments.
- [ ] The multiple realizability of cognition.

---

### **Question 6**
**“Neurons that wire together, fire together” is a description of which type of learning?**

- [ ] Backpropagation of error.
- [x] Hebbian learning.
- [ ] Perceptron convergence.

---

### **Question 7**
**Why are neural networks models important for thinking about language learning?**

- [ ] Because of the poverty of the stimulus argument.
- [ ] Because they are accurate models of how the brain works.
- [x] Because they can mirror aspects of language learning without having linguistic rules explicitly coded into them.

---

### **Question 8**
**Which of the following is a common feature of blindsight and neglect patients?**

- [ ] They have no residual awareness in the regions of their visual field where they describe themselves as having conscious awareness.
- [ ] They fail to respond to primes in the regions of their visual field where they lack conscious awareness.
- [x] They typically do not initiate movements towards objects in the regions of their visual field where they lack conscious awareness.

---


You must respond with a JSON object containing a "quiz" array. Each question should have a "question" field and an "options" array where each option has "option" (string) and "correct" (boolean) properties.`,
      model: "gpt-4o",
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStoreId],
        },
      },
    });

    // Create a thread
    const thread = await client.beta.threads.create();

    // Construct the user prompt
    const actionText = existingQuestions.length > 0 ? "10 MORE NEW" : "10";
    let userPrompt = `Generate ${actionText} quiz questions based on the content of the uploaded documents. Each question should have 4 options, with exactly one correct answer.

Please analyze the documents using file search and create comprehensive quiz questions that test understanding of the key concepts, facts, and ideas presented in the materials.`;

    if (existingQuestions.length > 0) {
      const previousQuestionsContext = existingQuestions
        .map((q: string) => `- ${q}`)
        .join("\n");
      userPrompt += `\n\nIMPORTANT: Do NOT repeat any of the following questions that have already been asked:\n${previousQuestionsContext}`;
    }

    userPrompt += `\n\nRespond with a JSON object in exactly this format:
{
  "quiz": [
    {
      "question": "Your question text here?",
      "options": [
        {"option": "First option text", "correct": false},
        {"option": "Second option text", "correct": true},
        {"option": "Third option text", "correct": false},
        {"option": "Fourth option text", "correct": false}
      ]
    }
  ]
}`;

    // Add message to thread
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userPrompt,
    });

    // Run the assistant
    const run = await client.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistant.id,
    });

    if (run.status === "completed") {
      // Get the assistant's response
      const messages = await client.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(
        (message) => message.role === "assistant",
      );

      if (!assistantMessage || !assistantMessage.content[0]) {
        throw new Error("No response from assistant");
      }

      const responseText = (
        assistantMessage.content[0] as { text: { value: string } }
      ).text.value;

      // Parse the JSON response
      let parsedResponse;
      try {
        // Extract JSON from the response (in case there's extra text)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          parsedResponse = JSON.parse(responseText);
        }
      } catch {
        console.error("Failed to parse assistant response:", responseText);

        // Fallback: use structured output with chat completions
        const completion = await client.beta.chat.completions.parse({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are an expert quiz generator. Create high-quality multiple-choice questions based on the provided context.",
            },
            {
              role: "user",
              content: `Based on the following context, ${userPrompt}\n\nContext: ${responseText}`,
            },
          ],
          response_format: zodResponseFormat(QuizSchema, "quiz_response"),
          temperature: 0.7,
          max_tokens: 4000,
        });

        const message = completion.choices[0]?.message;
        if (!message?.parsed) {
          throw new Error("Failed to generate structured quiz response");
        }

        parsedResponse = message.parsed;
      }

      // Validate the response against our schema
      const validatedQuiz = QuizSchema.parse(parsedResponse);

      // Clean up resources
      await client.beta.assistants.del(assistant.id);
      await client.beta.threads.del(thread.id);

      return new Response(JSON.stringify(validatedQuiz), {
        headers: jsonHeaders,
      });
    } else {
      // Clean up resources
      await client.beta.assistants.del(assistant.id);
      await client.beta.threads.del(thread.id);

      throw new Error(`Assistant run failed with status: ${run.status}`);
    }
  } catch (error: unknown) {
    console.error("API Error in /api/chat:", error);

    let errorMessage =
      "An unexpected error occurred while generating the quiz.";
    let statusCode = 500;

    if (error && typeof error === "object" && "message" in error) {
      errorMessage = (error as Error).message;
    }

    // Handle OpenAI API errors
    if (error && typeof error === "object" && "status" in error) {
      const openAIError = error as { status: number; message?: string };
      statusCode = openAIError.status;
      errorMessage =
        openAIError.message || `OpenAI API Error: ${openAIError.status}`;
    }

    // Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          message: "Invalid quiz format generated by AI.",
          errors: error.format(),
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    return new Response(
      JSON.stringify({
        message: errorMessage,
        error:
          process.env.NODE_ENV === "development"
            ? (error as Error)?.stack
            : undefined,
      }),
      {
        status: statusCode,
        headers: jsonHeaders,
      },
    );
  }
}

// Handle CORS preflight requests
export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
