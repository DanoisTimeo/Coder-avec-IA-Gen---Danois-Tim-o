// App.tsx

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { indexedDbService } from './services/indexedDbService';
import { pokemonApiService } from './services/pokemonApiService';
import { Pokemon, TokenBalance, AppMessage, PokemonStatus, PokemonRarity, PokemonEvolution } from './types';
import Button from './components/Button';
import Modal from './components/Modal';
import { PlusCircle, Coins, Sparkles, RefreshCw, XCircle, Gem, Loader2 } from 'lucide-react';
import { GoogleGenAI, Type, Modality } from "@google/genai";

const GENERATION_COST = 10;

const getRarityResellValue = (rarity: PokemonRarity): number => {
  switch (rarity) {
    case PokemonRarity.S_PLUS: return 25;
    case PokemonRarity.S: return 15;
    case PokemonRarity.A: return 10;
    case PokemonRarity.B: return 5;
    case PokemonRarity.C: return 4;
    case PokemonRarity.D: return 3;
    case PokemonRarity.E: return 2;
    case PokemonRarity.F: return 1;
    default: return 1;
  }
};

const rarityOrderMap: Record<PokemonRarity, number> = {
  [PokemonRarity.S_PLUS]: 7,
  [PokemonRarity.S]: 6,
  [PokemonRarity.A]: 5,
  [PokemonRarity.B]: 4,
  [PokemonRarity.C]: 3,
  [PokemonRarity.D]: 2,
  [PokemonRarity.E]: 1,
  [PokemonRarity.F]: 0,
};

const App: React.FC = () => {
  const [pokemons, setPokemons] = useState<Pokemon[]>([]);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isGeneratingPokemon, setIsGeneratingPokemon] = useState<boolean>(false);
  const [isGeneratingEvolutionForPokemonId, setIsGeneratingEvolutionForPokemonId] = useState<string | null>(null);
  const [message, setMessage] = useState<AppMessage | null>(null);
  const [sortOrder, setSortOrder] = useState('date-desc');

  // Modal states
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalTitle, setModalTitle] = useState<string>('');
  const [modalContent, setModalContent] = useState<React.ReactNode>(null);
  const [modalOnConfirm, setModalOnConfirm] = useState<(() => void) | undefined>(undefined);
  const [isModalConfirmLoading, setIsModalConfirmLoading] = useState<boolean>(false);
  const [pokemonToResellId, setPokemonToResellId] = useState<string | null>(null);

  // FIX: Moved showMessage before fetchAppData because it is used inside it.
  const showMessage = useCallback((type: 'success' | 'error' | 'warning', text: string) => {
    setMessage({ type, text });
    const timer = setTimeout(() => {
      setMessage(null);
    }, 5000); // Message disappears after 5 seconds
    return () => clearTimeout(timer);
  }, []);

  const fetchAppData = useCallback(async () => {
    setIsLoading(true);
    try {
      const fetchedPokemons = await indexedDbService.getPokemons();
      setPokemons(fetchedPokemons);
      
      const balance = await indexedDbService.getTokenBalance();
      setTokenBalance(balance.amount);
      setMessage(null);
    } catch (error) {
      console.error("Failed to fetch app data:", error);
      showMessage('error', 'Failed to load app data. Please try again.');
    } finally {
      setIsLoading(false);
    }
  // FIX: Added showMessage to dependency array.
  }, [showMessage]);

  useEffect(() => {
    fetchAppData();
  }, [fetchAppData]);

  const handleGeneratePokemon = async () => {
    if (tokenBalance < GENERATION_COST) {
      showMessage('warning', `You need ${GENERATION_COST} tokens to generate a Pokémon. Current balance: ${tokenBalance}.`);
      return;
    }

    setIsGeneratingPokemon(true);
    let originalTokenBalance = tokenBalance; // Store original balance for rollback
    
    try {
      // Deduct tokens immediately
      const newBalanceAfterDeduction = originalTokenBalance - GENERATION_COST;
      setTokenBalance(newBalanceAfterDeduction);
      await indexedDbService.updateTokenBalance(newBalanceAfterDeduction);
      
      const newPokemon = await pokemonApiService.generatePokemon();
      await indexedDbService.addPokemon(newPokemon);
      setPokemons((prevPokemons) => [newPokemon, ...prevPokemons]);
      showMessage('success', `Awesome! You generated a new Pokémon: ${newPokemon.name} (${newPokemon.rarity})!`);
      
    } catch (error) {
      console.error("Error generating Pokémon:", error);
      // Rollback token deduction on failure
      const revertedBalance = originalTokenBalance;
      setTokenBalance(revertedBalance);
      await indexedDbService.updateTokenBalance(revertedBalance);
      showMessage('error', `Failed to generate Pokémon: ${error instanceof Error ? error.message : String(error)}. Tokens refunded.`);
    } finally {
      setIsGeneratingPokemon(false);
    }
  };

  const handleGenerateEvolution = async (pokemon: Pokemon) => {
    setIsGeneratingEvolutionForPokemonId(pokemon.id);
    try {
      // Initialize GoogleGenAI within the function as per guidelines
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY }); 

      // 1. Generate textual description (name, description, stats)
      const textPrompt = `Given the Pokémon named '${pokemon.name}' with rarity '${pokemon.rarity}', create a concept for its evolution. Provide a new, coherent name for the evolution, a brief description of its appearance and abilities, and a short summary of its key stats. Format the response as a JSON object with 'evolutionName' (string), 'evolutionDescription' (string), and 'evolutionStats' (string) fields.`;

      const textResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: textPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              evolutionName: { type: Type.STRING, description: 'The name of the evolved Pokémon.' },
              evolutionDescription: { type: Type.STRING, description: 'A brief description of the evolved Pokémon\'s appearance and abilities.' },
              evolutionStats: { type: Type.STRING, description: 'A short summary of the evolved Pokémon\'s key stats.' },
            },
            required: ["evolutionName", "evolutionDescription", "evolutionStats"],
            propertyOrdering: ["evolutionName", "evolutionDescription", "evolutionStats"],
          },
          thinkingConfig: { thinkingBudget: 0 } // For faster text generation
        },
      });

      let evolutionTextData: { evolutionName: string; evolutionDescription: string; evolutionStats: string; };
      try {
        evolutionTextData = JSON.parse(textResponse.text.trim());
      } catch (parseError) {
        throw new Error(`Failed to parse evolution text response from AI: ${parseError}. Raw response: ${textResponse.text}`);
      }

      const { evolutionName, evolutionDescription, evolutionStats } = evolutionTextData;

      // 2. Generate evolution image
      const imagePrompt = `Generate a highly detailed and stylized image of the evolved form of a Pokémon named '${pokemon.name}'. The evolution, named '${evolutionName}', should clearly reflect its origin but appear more powerful, mature, and visually distinct, incorporating design elements suggested by its original form and its rarity '${pokemon.rarity}'. Focus on a vibrant, eye-catching style.`;

      const imageResponse = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001', // High-quality image generation model
        prompt: imagePrompt,
        config: {
          numberOfImages: 1,
          outputMimeType: 'image/png', 
          aspectRatio: '1:1', // Standard aspect ratio for Pokémon images
        },
      });

      const evolutionImageBase64 = imageResponse.generatedImages[0].image.imageBytes;

      const newEvolution: PokemonEvolution = {
        evolutionName,
        evolutionDescription,
        evolutionStats,
        evolutionImageBase64,
        generatedAt: new Date().toISOString(),
      };

      const updatedPokemon = { ...pokemon, evolution: newEvolution };
      await indexedDbService.updatePokemon(updatedPokemon);

      setPokemons((prevPokemons) =>
        prevPokemons.map((p) => (p.id === updatedPokemon.id ? updatedPokemon : p)),
      );
      showMessage('success', `Evolution created for ${pokemon.name}! Meet ${evolutionName}!`);

    } catch (error) {
      console.error("Error generating evolution:", error);
      showMessage('error', `Failed to generate evolution for ${pokemon.name}: ${error instanceof Error ? error.message : String(error)}. Please check the console for more details.`);
    } finally {
      setIsGeneratingEvolutionForPokemonId(null);
    }
  };

  // FIX: Moved closeModal before handleResellConfirmation as it is used inside it.
  const closeModal = () => {
    setIsModalOpen(false);
    setPokemonToResellId(null);
    setModalTitle('');
    setModalContent(null);
    setModalOnConfirm(undefined);
    setIsModalConfirmLoading(false);
  };

  const handleResellConfirmation = (pokemonId: string, pokemonName: string) => {
    const pokemonToConfirm = pokemons.find(p => p.id === pokemonId);
    if (!pokemonToConfirm) {
      showMessage('error', 'Could not find the Pokémon to resell.');
      return;
    }
    
    const resellValue = getRarityResellValue(pokemonToConfirm.rarity);

    setPokemonToResellId(pokemonId);
    setModalTitle('Resell Pokémon');
    setModalContent(
      <p className="text-gray-700">
        Are you sure you want to resell <span className="font-semibold text-indigo-700">{pokemonName}</span>?
        You will receive <span className="font-bold text-green-600">{resellValue} tokens</span> back. This action cannot be undone.
      </p>
    );
    // FIX: The onConfirm function must return void. The async logic is wrapped in an IIFE.
    const onConfirmAction = () => {
      (async () => {
        setIsModalConfirmLoading(true);
        try {
          const pokemonToResell = pokemons.find(p => p.id === pokemonId);
          if (pokemonToResell) {
            const updatedPokemon = { ...pokemonToResell, status: PokemonStatus.RESOLD };
            await indexedDbService.updatePokemon(updatedPokemon);
            
            const currentResellValue = getRarityResellValue(pokemonToResell.rarity);
            const newBalance = tokenBalance + currentResellValue;
            await indexedDbService.updateTokenBalance(newBalance);

            // Update state after DB operations are successful
            setPokemons((prevPokemons) =>
              prevPokemons.map((p) => (p.id === updatedPokemon.id ? updatedPokemon : p)),
            );
            setTokenBalance(newBalance);
            
            showMessage('success', `${pokemonToResell.name} resold successfully! You gained ${currentResellValue} tokens.`);
          }
        } catch (error) {
          console.error("Error reselling Pokémon:", error);
          showMessage('error', `Failed to resell Pokémon: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setIsModalConfirmLoading(false);
          closeModal();
        }
      })();
    };
    setModalOnConfirm(() => onConfirmAction);
    setIsModalOpen(true);
  };

  // Memoized rarity colors for consistent styling
  const getRarityColor = useCallback((rarity: PokemonRarity) => {
    switch (rarity) {
      case PokemonRarity.F: return 'bg-gray-200 text-gray-800';
      case PokemonRarity.E: return 'bg-gray-300 text-gray-900';
      case PokemonRarity.D: return 'bg-blue-100 text-blue-800';
      case PokemonRarity.C: return 'bg-green-100 text-green-800';
      case PokemonRarity.B: return 'bg-purple-100 text-purple-800';
      case PokemonRarity.A: return 'bg-yellow-100 text-yellow-800';
      case PokemonRarity.S: return 'bg-orange-100 text-orange-800';
      case PokemonRarity.S_PLUS: return 'bg-red-100 text-red-800 font-bold';
      default: return 'bg-gray-100 text-gray-700';
    }
  }, []);

  const sortedPokemons = useMemo(() => {
    const pokemonsToSort = [...pokemons];
    switch (sortOrder) {
      case 'rarity-desc':
        return pokemonsToSort.sort((a, b) => rarityOrderMap[b.rarity] - rarityOrderMap[a.rarity]);
      case 'rarity-asc':
        return pokemonsToSort.sort((a, b) => rarityOrderMap[a.rarity] - rarityOrderMap[b.rarity]);
      case 'name-asc':
        return pokemonsToSort.sort((a, b) => a.name.localeCompare(b.name));
      case 'name-desc':
        return pokemonsToSort.sort((a, b) => b.name.localeCompare(a.name));
      case 'date-asc':
        return pokemonsToSort.sort((a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime());
      case 'date-desc':
      default:
        return pokemonsToSort.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
    }
  }, [pokemons, sortOrder]);

  return (
    <div className="container mx-auto p-4 sm:p-6 lg:p-8">
      <h1 className="text-4xl sm:text-5xl font-extrabold text-center mb-10 text-indigo-800 drop-shadow-md">
        Pokémon Generator Lab
      </h1>

      {message && (
        <div
          className={`p-4 mb-6 rounded-lg shadow-md flex items-center justify-between transition-opacity duration-300 ${
            message.type === 'success' ? 'bg-green-100 text-green-800' :
            message.type === 'error' ? 'bg-red-100 text-red-800' :
            'bg-yellow-100 text-yellow-800'
          }`}
          role="alert"
        >
          <p className="font-medium">{message.text}</p>
          <Button variant="ghost" size="sm" onClick={() => setMessage(null)}>
            <XCircle className="h-5 w-5" />
          </Button>
        </div>
      )}

      {/* Token Balance */}
      <div className="bg-yellow-50 p-4 sm:p-6 rounded-xl shadow-md mb-8 flex items-center justify-between">
        <h2 className="text-xl sm:text-2xl font-bold text-yellow-800 flex items-center gap-3">
          <Gem className="h-7 w-7 text-yellow-600" />
          Your Tokens:
        </h2>
        <span className="text-3xl sm:text-4xl font-extrabold text-yellow-900 leading-none">
          {tokenBalance}
        </span>
      </div>

      {/* Generate Pokémon Section */}
      <div className="bg-white p-6 sm:p-8 rounded-xl shadow-lg mb-10 text-center">
        <h2 className="text-2xl sm:text-3xl font-bold mb-4 text-gray-900">
          Generate New Pokémon
        </h2>
        <p className="text-gray-600 mb-6">
          Unleash the power of AI to create a unique Pokémon!
          (Cost: <span className="font-semibold text-red-600">{GENERATION_COST} Tokens</span>)
        </p>
        <Button
          onClick={handleGeneratePokemon}
          variant="primary"
          size="lg"
          className="w-full sm:w-auto flex items-center justify-center gap-2"
          disabled={isGeneratingPokemon || isLoading || tokenBalance < GENERATION_COST}
        >
          {isGeneratingPokemon ? (
            <span className="flex items-center">
              <Loader2 className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
              Generating...
            </span>
          ) : (
            <>
              <Sparkles className="h-5 w-5" />
              Generate Pokémon
            </>
          )}
        </Button>
      </div>

      {/* Pokémon Collection */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-8">
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 text-center sm:text-left mb-4 sm:mb-0">Your Collection</h2>
        {pokemons.length > 1 && (
          <div className="flex items-center gap-2 self-center sm:self-auto">
            <label htmlFor="sort-order" className="text-gray-600 font-medium">Sort by:</label>
            <select
              id="sort-order"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="bg-white border border-gray-300 rounded-md shadow-sm pl-3 pr-8 py-2 text-left cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            >
              <option value="date-desc">Newest First</option>
              <option value="date-asc">Oldest First</option>
              <option value="rarity-desc">Rarity (High to Low)</option>
              <option value="rarity-asc">Rarity (Low to High)</option>
              <option value="name-asc">Name (A-Z)</option>
              <option value="name-desc">Name (Z-A)</option>
            </select>
          </div>
        )}
      </div>
      
      {isLoading ? (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="animate-spin h-10 w-10 text-indigo-600" />
          <p className="ml-4 text-lg text-gray-600">Loading your Pokémon...</p>
        </div>
      ) : sortedPokemons.length === 0 ? (
        <p className="text-center text-gray-500 text-xl py-12 bg-white rounded-xl shadow-md">
          You haven't generated any Pokémon yet. Start creating above!
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedPokemons.map((pokemon) => {
            const resellValue = getRarityResellValue(pokemon.rarity);
            return (
              <div key={pokemon.id} className="bg-white p-6 rounded-xl shadow-md border border-gray-100 hover:shadow-lg transition-shadow duration-200 flex flex-col">
                <div className="flex-grow">
                  <div className="relative w-full h-48 mb-4 rounded-lg overflow-hidden bg-gray-100 flex items-center justify-center">
                    <img
                      src={`data:image/png;base64,${pokemon.imageBase64}`}
                      alt={pokemon.name}
                      className="object-contain w-full h-full"
                      loading="lazy"
                    />
                    {pokemon.status === PokemonStatus.RESOLD && (
                      <div className="absolute inset-0 bg-gray-800 bg-opacity-75 flex items-center justify-center text-white text-lg font-bold">
                        RESOLD
                      </div>
                    )}
                  </div>
                  <h3 className="text-xl font-semibold mb-2 text-gray-900 flex items-center justify-between">
                    <span>{pokemon.name}</span>
                    <span className={`text-xs px-2 py-1 rounded-full ${getRarityColor(pokemon.rarity)}`}>
                      {pokemon.rarity}
                    </span>
                  </h3>
                </div>
                <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-2">
                  <div className="flex justify-between items-center text-sm text-gray-500">
                    <span>Generated: {new Date(pokemon.generatedAt).toLocaleDateString()}</span>
                    {pokemon.status === PokemonStatus.OWNED ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleResellConfirmation(pokemon.id, pokemon.name)}
                        aria-label={`Resell ${pokemon.name} for ${resellValue} tokens`}
                        disabled={isGeneratingEvolutionForPokemonId === pokemon.id}
                      >
                        <Coins className="h-4 w-4 mr-1" /> Resell (+{resellValue})
                      </Button>
                    ) : (
                      <span className="text-red-500 flex items-center gap-1">
                        <RefreshCw className="h-4 w-4" /> Resold
                      </span>
                    )}
                  </div>
                  {pokemon.status === PokemonStatus.OWNED && (
                    <Button
                      size="sm"
                      onClick={() => handleGenerateEvolution(pokemon)}
                      disabled={isGeneratingEvolutionForPokemonId === pokemon.id}
                      className="rounded-full bg-blue-200 text-blue-800 hover:bg-blue-300 w-full flex items-center justify-center gap-1"
                    >
                      {isGeneratingEvolutionForPokemonId === pokemon.id ? (
                        <span className="flex items-center">
                          <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                          Evolving...
                        </span>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" /> Create Evolution
                        </>
                      )}
                    </Button>
                  )}
                </div>

                {/* Evolution Display Block */}
                {pokemon.evolution && (
                  <div className="mt-4 pt-4 border-t border-blue-100 bg-blue-50 rounded-lg p-4">
                    <h4 className="text-lg font-bold text-blue-800 mb-2 flex items-center gap-2">
                      <RefreshCw className="h-5 w-5 text-blue-600" /> Evolution: {pokemon.evolution.evolutionName}
                    </h4>
                    <div className="w-full h-32 mb-3 rounded-lg overflow-hidden bg-white flex items-center justify-center border border-blue-100">
                      <img
                        src={`data:image/png;base64,${pokemon.evolution.evolutionImageBase64}`}
                        alt={pokemon.evolution.evolutionName}
                        className="object-contain w-full h-full"
                        loading="lazy"
                      />
                    </div>
                    <p className="text-sm text-gray-700 mb-2">{pokemon.evolution.evolutionDescription}</p>
                    <p className="text-sm text-gray-600 font-medium">Stats: {pokemon.evolution.evolutionStats}</p>
                    <p className="text-xs text-gray-500 mt-2">Evolved: {new Date(pokemon.evolution.generatedAt).toLocaleDateString()}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={modalTitle}
        onConfirm={modalOnConfirm}
        confirmButtonText="Resell"
        cancelButtonText="Cancel"
        confirmButtonVariant="primary" // Changed to primary for resell
        isLoading={isModalConfirmLoading}
      >
        {modalContent}
      </Modal>
    </div>
  );
};

export default App;