import { NextRequest } from "next/server";
import OpenAI from "openai";

export const maxDuration = 120;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const jsonHeaders = { "Content-Type": "application/json" };

export async function POST(req: NextRequest) {
  try {
    // Parse the form data using Web API
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return new Response(
        JSON.stringify({
          message:
            "No PDF files were uploaded. Please select at least one PDF file.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Validate that all files are PDFs
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        return new Response(
          JSON.stringify({
            message: `File ${file.name} is not a PDF. Please upload only PDF files.`,
          }),
          {
            status: 400,
            headers: jsonHeaders,
          },
        );
      }
    }

    // Create a new vector store
    const vectorStore = await client.vectorStores.create({
      name: `Quiz PDFs - ${new Date().toISOString()}`,
      expires_after: {
        anchor: "last_active_at",
        days: 7,
      },
    });

    // Upload files to OpenAI and collect file IDs
    const uploadedFileIds: string[] = [];

    try {
      for (const file of files) {
        // Upload file to OpenAI
        const uploadedFile = await client.files.create({
          file: file,
          purpose: "assistants",
        });

        uploadedFileIds.push(uploadedFile.id);
      }

      // Add all files to the vector store using batch create
      const batch = await client.vectorStores.fileBatches.createAndPoll(
        vectorStore.id,
        { file_ids: uploadedFileIds },
      );

      // Check if the batch was successful
      if (batch.status === "completed") {
        return new Response(
          JSON.stringify({
            vectorStoreId: vectorStore.id,
            message: `Successfully uploaded ${files.length} PDF files to vector store.`,
            filesUploaded: files.length,
            batchId: batch.id,
          }),
          {
            headers: jsonHeaders,
          },
        );
      } else if (batch.status === "failed") {
        // Clean up on failure
        await cleanupResources(vectorStore.id, uploadedFileIds);

        return new Response(
          JSON.stringify({
            message:
              "File upload batch failed. Please try again with different files.",
            details: batch,
          }),
          {
            status: 500,
            headers: jsonHeaders,
          },
        );
      } else {
        return new Response(
          JSON.stringify({
            message: `File upload is still in progress. Status: ${batch.status}`,
            vectorStoreId: vectorStore.id,
            batchId: batch.id,
          }),
          {
            headers: jsonHeaders,
          },
        );
      }
    } catch (uploadError) {
      // Clean up on error
      await cleanupResources(vectorStore.id, uploadedFileIds);
      throw uploadError;
    }
  } catch (error: unknown) {
    console.error("API Error in /api/upload:", error);

    let errorMessage = "An unexpected error occurred during file upload.";
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

// Helper function to clean up resources on error
async function cleanupResources(vectorStoreId: string, fileIds: string[]) {
  // Clean up any uploaded files
  for (const fileId of fileIds) {
    try {
      await client.files.del(fileId);
    } catch (error) {
      console.warn(`Failed to delete OpenAI file ${fileId}:`, error);
    }
  }

  // Try to delete the vector store
  try {
    await client.vectorStores.del(vectorStoreId);
  } catch (error) {
    console.warn(`Failed to delete vector store ${vectorStoreId}:`, error);
  }
}
